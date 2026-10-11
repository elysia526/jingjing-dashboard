/* ============================================================================
 * remind.js — 提醒引擎（计时器到点 / 闹钟到点 共用）
 * ----------------------------------------------------------------------------
 * 一条提醒要同时做四件事，任何一件失败都不能拖垮其余三件：
 *
 *   1. **页面浮层** —— 最可靠的一条。Android WebView 里 window.Notification
 *      基本不可用，所以"屏幕上弹出来"才是真正兜底的通道，必须最先做。
 *   2. **响铃** —— 两种来源：
 *        · 内置：用 WebAudio 现场合成，不占体积、不需要任何音频文件
 *        · 自定义：用户导入的音频文件，存在 IndexedDB 里（localStorage 兜底）
 *   3. **震动** —— navigator.vibrate。Android WebView 需要壳声明 VIBRATE 权限。
 *   4. **系统通知** —— Notification API。浏览器里有就用，WebView 里没有就跳过。
 *
 * 几个容易踩的点，都在这里处理掉了：
 *   · 浏览器**禁止无用户手势的自动播放**。AudioContext 必须在用户第一次交互后
 *     才 resume；所以 start() 会尝试 resume，失败就静默降级为"只震动+浮层"。
 *   · **音量渐入**：直接最大音量容易吓人，也容易在安静环境里失礼。
 *   · **夜间勿扰**：夜里闹钟该响还得响，但计时器提醒可以只震动（可配置）。
 *   · **贪睡**：不销毁这次提醒，只是把它推迟 N 分钟重新排队。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LS_CFG = 'dash.remind.cfg';
  var DB_NAME = 'dash-media';
  var DB_VER = 1;
  var STORE = 'kv';
  var LS_AUDIO = 'dash.remind.audio';        /* localStorage 兜底时存 dataURL */
  var LS_AUDIO_NAME = 'dash.remind.audioName';

  /* 配置版本：改默认值时要靠它把老配置纠正过来（见 loadCfg） */
  var CFG_VER = 2;

  var DEFAULT_CFG = {
    sound: 1,              /* 响铃 */
    vibrate: 1,            /* 震动 */
    notify: 0,             /* 系统通知（WebView 里用不了，默认关） */
    tone: 'chime',         /* chime | beep | pulse | classic | urgent | custom */
    volume: 70,            /* 0–100 */
    snoozeMin: 5,
    fadeIn: 1,             /* 音量渐入 */
    /* 夜间时段：计时器提醒只震动，闹钟照响。
       ⚠ 默认必须是 **0**。设成 1 的话，白天/夜间划分一过 18:00，
         倒计时就突然不响了 —— 用户只会觉得"倒计时坏了"（闹钟没事，
         因为闹钟不受这条约束）。这个坑真踩过。 */
    quietTimerVibeOnly: 0,
    _v: CFG_VER
  };

  /* 内置铃声：用振荡器现场合成，loop = 一轮时长（秒），t = 轮内偏移 */
  var TONES = {
    chime: {
      label: '叮咚', loop: 1.9, notes: [
        { f: 784, d: .20, t: 0, g: .85 },
        { f: 587, d: .45, t: .22, g: .75 },
        { f: 523, d: 1.0, t: .46, g: .60 }
      ]
    },
    beep: {
      label: '滴滴', loop: 1.3, notes: [
        { f: 1046, d: .10, t: 0, g: .9 },
        { f: 1046, d: .10, t: .18, g: .9 },
        { f: 1046, d: .10, t: .36, g: .9 }
      ]
    },
    pulse: {
      label: '脉冲', loop: 1.1, notes: [
        { f: 660, d: .14, t: 0, g: .85 },
        { f: 660, d: .14, t: .34, g: .85 }
      ]
    },
    classic: {
      label: '经典闹铃', loop: 1.0, notes: [
        { f: 880, d: .11, t: 0, g: .9 },
        { f: 1109, d: .11, t: .13, g: .9 },
        { f: 880, d: .11, t: .26, g: .9 },
        { f: 1109, d: .11, t: .39, g: .9 }
      ]
    },
    urgent: {
      label: '急促', loop: .72, notes: [
        { f: 1319, d: .07, t: 0, g: 1 },
        { f: 1319, d: .07, t: .12, g: 1 },
        { f: 1319, d: .07, t: .24, g: 1 },
        { f: 1319, d: .07, t: .36, g: 1 }
      ]
    }
  };

  var cfg = loadCfg();
  var ringing = null;          /* { kind, title, sub, timeText, since } */
  var queue = [];              /* 已有提醒在响时，后来的排队等 */
  var snoozeTimer = null;
  var audioEl = null;          /* 自定义铃声用 */
  var audioUrl = null;
  var customBlob = null;       /* 已加载的自定义音频 Blob */
  var customLoaded = false;
  var vibTimer = null;
  var actCbs = [];

  var actx = null;
  var master = null;
  var toneTimer = null;
  var nextCycleAt = 0;
  var fadeGain = null;

  var idb = null;
  var idbState = 'pending';
  var readyCbs = [];

  /* ---------------------------------------------------------------- 配置 */
  function loadCfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(LS_CFG) || '{}') || {}; } catch (e) {}
    var out = {};
    for (var k in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) {
        out[k] = (c[k] === undefined || c[k] === null) ? DEFAULT_CFG[k] : c[k];
      }
    }
    /* v1 → v2：quietTimerVibeOnly 的默认值从 1 改成 0。
       v1 那份配置里的 1 是"旧默认值"，不是用户主动选的，直接纠正；
       打过 _v=2 标记之后就不再动它，用户自己的选择会被尊重。 */
    if (!c._v || +c._v < 2) { out.quietTimerVibeOnly = 0; }
    out._v = CFG_VER;
    return out;
  }
  function saveCfg() {
    try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) {}
  }
  function setCfg(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) { cfg[k] = patch[k]; }
    }
    saveCfg();
  }

  /* ------------------------------------------- 自定义音频存储（IndexedDB） */
  function openIdb() {
    return new Promise(function (resolve) {
      var settled = false;
      function fin(db) { if (!settled) { settled = true; resolve(db || null); } }
      try {
        if (!global.indexedDB) { fin(null); return; }
        var req = global.indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) { db.createObjectStore(STORE); }
        };
        req.onsuccess = function () { fin(req.result); };
        req.onerror = function () { fin(null); };
        req.onblocked = function () { fin(null); };
        setTimeout(function () { fin(null); }, 2500);
      } catch (e) { fin(null); }
    });
  }

  function initStore() {
    var full = openIdb().then(function (db) {
      idb = db; idbState = db ? 'idb' : 'ls';
      notify();
    });
    var early = new Promise(function (res) {
      setTimeout(function () { if (idbState === 'pending') { idbState = 'ls'; notify(); } res(); }, 2500);
    });
    return Promise.race([early, full]);
  }

  function notify() {
    var cbs = readyCbs; readyCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](idbState); } catch (e) {} }
  }
  function onReady(fn) {
    if (idbState !== 'pending') { fn(idbState); return; }
    readyCbs.push(fn);
  }

  function idbTx(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!idb) { reject(new Error('no idb')); return; }
      var t, req;
      try {
        t = idb.transaction(STORE, mode);
        req = fn(t.objectStore(STORE));
      } catch (e) { reject(e); return; }
      t.oncomplete = function () { resolve(req ? req.result : undefined); };
      t.onerror = function () { reject(t.error || new Error('idb error')); };
      t.onabort = function () { reject(t.error || new Error('idb abort')); };
    });
  }

  /** 存自定义铃声。大文件走 IndexedDB；localStorage 兜底时转成 dataURL（上限约 1.2MB） */
  function putAudio(blob, name) {
    customBlob = blob;
    customLoaded = true;
    if (idb) {
      return idbTx('readwrite', function (s) { return s.put(blob, 'ringtone'); })
        .then(function () {
          try { localStorage.setItem(LS_AUDIO_NAME, name || ''); } catch (e) {}
          return true;
        });
    }
    if (blob.size > 1.2 * 1024 * 1024) {
      return Promise.reject(new Error('当前环境只能用 localStorage 兜底，音频不能超过 1.2 MB'));
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          localStorage.setItem(LS_AUDIO, fr.result);
          localStorage.setItem(LS_AUDIO_NAME, name || '');
          resolve(true);
        } catch (e) { reject(new Error('本地存储放不下这个音频')); }
      };
      fr.onerror = function () { reject(new Error('读取音频失败')); };
      fr.readAsDataURL(blob);
    });
  }

  function getAudioBlob() {
    if (customLoaded) { return Promise.resolve(customBlob); }
    if (idb) {
      return idbTx('readonly', function (s) { return s.get('ringtone'); }).then(function (b) {
        customBlob = b || null; customLoaded = true;
        return customBlob;
      }).catch(function () { customLoaded = true; return null; });
    }
    customLoaded = true;
    return Promise.resolve(null);
  }

  function clearAudio() {
    customBlob = null; customLoaded = true;
    try { localStorage.removeItem(LS_AUDIO); localStorage.removeItem(LS_AUDIO_NAME); } catch (e) {}
    if (idb) { idbTx('readwrite', function (s) { return s.delete('ringtone'); }).catch(function () {}); }
    stopSound();
    return Promise.resolve(true);
  }

  function hasAudio() {
    try { return !!localStorage.getItem(LS_AUDIO_NAME) || !!customBlob; } catch (e) { return !!customBlob; }
  }
  function audioName() {
    try { return localStorage.getItem(LS_AUDIO_NAME) || ''; } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------ 响铃引擎 */
  function ensureCtx() {
    if (actx) { return actx; }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) { return null; }
    try { actx = new AC(); } catch (e) { actx = null; }
    return actx;
  }

  /** 页面第一次被点过之后解锁音频（浏览器自动播放策略） */
  function unlock() {
    var c = ensureCtx();
    if (!c) { return; }
    if (c.state === 'suspended') { c.resume().catch(function () {}); }
  }

  function stopSound() {
    if (toneTimer) { clearInterval(toneTimer); toneTimer = null; }
    if (audioEl) {
      try { audioEl.pause(); } catch (e) {}
      audioEl = null;
    }
    if (audioUrl) { try { URL.revokeObjectURL(audioUrl); } catch (e) {} audioUrl = null; }
    if (actx && master) {
      try {
        master.gain.cancelScheduledValues(actx.currentTime);
        master.gain.setValueAtTime(master.gain.value, actx.currentTime);
        master.gain.linearRampToValueAtTime(0, actx.currentTime + .12);
      } catch (e) {}
    }
    master = null;
    fadeGain = null;
  }

  function vol() { return Math.max(0, Math.min(100, +cfg.volume || 0)) / 100; }

  function scheduleCycle(name, when) {
    var T = TONES[name];
    if (!T || !actx || !master) { return; }
    for (var i = 0; i < T.notes.length; i++) {
      var n = T.notes[i];
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = name === 'urgent' ? 'square' : 'sine';
      o.frequency.value = n.f;
      o.connect(g); g.connect(master);
      var t = when + n.t;
      try {
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(n.g, t + .012);
        g.gain.setValueAtTime(n.g, t + Math.max(.03, n.d - .05));
        g.gain.linearRampToValueAtTime(0.0001, t + n.d);
        o.start(t); o.stop(t + n.d + .03);
      } catch (e) {}
    }
  }

  function playSynth(name) {
    var c = ensureCtx();
    if (!c) { return false; }
    if (c.state === 'suspended') { c.resume().catch(function () {}); }
    var T = TONES[name] || TONES.chime;
    master = c.createGain();
    var target = vol();
    var now = c.currentTime;
    try {
      if (cfg.fadeIn) {
        master.gain.setValueAtTime(0.0001, now);
        master.gain.linearRampToValueAtTime(target, now + 1.6);
      } else {
        master.gain.setValueAtTime(target, now);
      }
    } catch (e) {}
    master.connect(c.destination);

    nextCycleAt = now + .05;
    function pump() {
      if (!actx || !master) { return; }
      var horizon = actx.currentTime + 2.2;
      while (nextCycleAt < horizon) {
        scheduleCycle(name, nextCycleAt);
        nextCycleAt += T.loop;
      }
    }
    pump();
    toneTimer = setInterval(pump, 1000);
    return true;
  }

  function playCustom(blob) {
    if (!blob) { return false; }
    try {
      if (audioUrl) { URL.revokeObjectURL(audioUrl); }
      audioUrl = URL.createObjectURL(blob);
      audioEl = new Audio(audioUrl);
      audioEl.loop = true;
      audioEl.volume = 0;
      var target = vol();
      var p = audioEl.play();
      if (p && p.catch) { p.catch(function () {}); }
      /* 音量渐入 */
      var steps = cfg.fadeIn ? 16 : 1;
      var i = 0;
      var iv = setInterval(function () {
        if (!audioEl) { clearInterval(iv); return; }
        i++;
        audioEl.volume = Math.min(target, target * i / steps);
        if (i >= steps) { clearInterval(iv); }
      }, cfg.fadeIn ? 90 : 1);
      return true;
    } catch (e) { return false; }
  }

  /* -------------------------------------------------------------- 震动 */
  function startVibrate() {
    stopVibrate();
    if (!global.navigator || !navigator.vibrate) { return; }
    var pattern = [420, 220, 420, 220, 420, 900];
    function buzz() { try { navigator.vibrate(pattern); } catch (e) {} }
    buzz();
    /* 单次 pattern 最长有限，靠重复补足 */
    var total = pattern.reduce(function (a, b) { return a + b; }, 0);
    vibTimer = setInterval(buzz, total);
  }
  function stopVibrate() {
    if (vibTimer) { clearInterval(vibTimer); vibTimer = null; }
    if (global.navigator && navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
  }

  /* -------------------------------------------------------------- 通知 */
  function systemNotify(title, body) {
    if (!cfg.notify) { return; }
    try {
      if (typeof Notification === 'undefined') { return; }
      if (Notification.permission === 'granted') {
        new Notification(title, { body: body, tag: 'dash-remind', renotify: true });
      }
    } catch (e) {}
  }

  function requestNotify() {
    return new Promise(function (resolve) {
      try {
        if (typeof Notification === 'undefined') { resolve('unsupported'); return; }
        if (Notification.permission === 'granted') { resolve('granted'); return; }
        if (Notification.permission === 'denied') { resolve('denied'); return; }
        var r = Notification.requestPermission(function (p) { resolve(p); });
        if (r && r.then) { r.then(resolve).catch(function () { resolve('denied'); }); }
      } catch (e) { resolve('unsupported'); }
    });
  }

  /* --------------------------------------------------------- 夜间勿扰判断 */
  function inQuietHours() {
    try {
      if (!global.Background) { return false; }
      return Background.currentSlot() === 'night';
    } catch (e) { return false; }
  }

  /* -------------------------------------------------------------- 触发 */
  /**
   * @param {Object} o
   *   o.kind      'timer' | 'alarm'
   *   o.title     主标题（如「倒计时」「闹钟」）
   *   o.sub       副标题（如计时器名 / 闹钟标签）
   *   o.timeText  大号时间文本（如 05:00 / 07:30）
   */
  /**
   * 触发提醒。**如果已经有在响的，就排队而不是把它顶掉** ——
   * 多个计时器同时到点、或者闹钟和计时器撞在一起时，
   * 顶掉的话用户只会看到最后一条，前面那条就永远丢了。
   */
  function fire(o) {
    o = o || {};
    if (ringing) {
      queue.push(o);
      if (queue.length > 8) { queue.shift(); }     /* 极端情况别无限堆积 */
      return null;
    }
    return doFire(o);
  }

  function doFire(o) {
    o = o || {};
    ringing = {
      kind: o.kind || 'timer',
      title: o.title || '提醒',
      sub: o.sub || '',
      timeText: o.timeText || '',
      since: Date.now()
    };
    render();

    var quiet = (ringing.kind === 'timer') && cfg.quietTimerVibeOnly && inQuietHours();
    var wantSound = !!cfg.sound && !quiet;
    /* 记下"是被夜间规则静音了"，浮层上要写出来 ——
       否则用户只看到提醒弹出来却没声音，会以为坏了 */
    ringing.muted = !!quiet;

    if (wantSound) {
      if (cfg.tone === 'custom') {
        getAudioBlob().then(function (blob) {
          if (!ringing) { return; }
          if (!playCustom(blob)) { playSynth('chime'); }
        });
      } else {
        playSynth(cfg.tone);
      }
    }
    if (cfg.vibrate) { startVibrate(); }
    systemNotify(ringing.title, (ringing.sub ? ringing.sub + ' ' : '') + ringing.timeText);
    for (var i = 0; i < actCbs.length; i++) { try { actCbs[i]('fire', ringing); } catch (e) {} }
    return ringing;
  }

  function stop() {
    if (!ringing) { return; }
    var was = ringing;
    ringing = null;
    stopSound();
    stopVibrate();
    if (snoozeTimer) { clearTimeout(snoozeTimer); snoozeTimer = null; }
    render();
    for (var i = 0; i < actCbs.length; i++) { try { actCbs[i]('stop', was); } catch (e) {} }
    /* 出队下一条，中间留一点空隙，免得听上去像没停过 */
    if (queue.length) {
      var nxt = queue.shift();
      setTimeout(function () { doFire(nxt); }, 500);
    }
  }

  function pendingCount() { return queue.length; }

  function snooze(min) {
    var was = ringing;
    if (!was) { return; }
    var m = +min || +cfg.snoozeMin || 5;
    stop();
    if (snoozeTimer) { clearTimeout(snoozeTimer); }
    snoozeTimer = setTimeout(function () {
      snoozeTimer = null;
      fire({ kind: was.kind, title: was.title, sub: (was.sub ? was.sub + ' · ' : '') + '贪睡', timeText: was.timeText });
    }, m * 60 * 1000);
    for (var i = 0; i < actCbs.length; i++) { try { actCbs[i]('snooze', was); } catch (e) {} }
  }

  /* -------------------------------------------------------------- 浮层 */
  function $(s) { return document.querySelector(s); }

  function render() {
    var box = $('#remindModal');
    if (!box) { return; }
    if (!ringing) {
      box.classList.remove('on');
      box.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('reminding');
      return;
    }
    var k = $('#rdKind'), t = $('#rdTime'), l = $('#rdLabel'), s = $('#rdSnoozeBtn');
    if (k) { k.textContent = ringing.title; }
    if (t) { t.textContent = ringing.timeText || ''; }
    if (l) { l.textContent = ringing.sub || ''; }
    if (s) { s.textContent = '贪睡 ' + (cfg.snoozeMin || 5) + ' 分钟'; }
    var nt = $('#rdNote');
    if (nt) {
      nt.hidden = !ringing.muted;
      nt.textContent = ringing.muted
        ? '夜间时段：计时器只震动不响铃（设置 → 提醒方式 里可以关掉这条规则）'
        : '';
    }
    box.classList.add('on');
    box.setAttribute('aria-hidden', 'false');
    document.body.classList.add('reminding');
  }

  function onAction(fn) { actCbs.push(fn); }

  /** 试听：不影响正在进行的提醒 */
  function test() {
    var before = ringing;
    var quietBackup = cfg.quietTimerVibeOnly;
    cfg.quietTimerVibeOnly = 0;
    fire({ kind: 'alarm', title: '试听', sub: cfg.tone === 'custom' ? (audioName() || '自定义音频') : TONES[cfg.tone].label, timeText: '00:00' });
    cfg.quietTimerVibeOnly = quietBackup;
    setTimeout(function () {
      if (before) { ringing = before; render(); return; }
      stop();
    }, 2600);
    return true;
  }

  /* -------------------------------------------------------------- 启动 */
  function start() {
    initStore();
    /* 任意一次点击都用来解锁音频上下文 */
    if (!global.__dashRemindUnlock) {
      global.__dashRemindUnlock = true;
      document.addEventListener('click', unlock, true);
      document.addEventListener('touchstart', unlock, true);
    }
    return true;
  }

  global.Remind = {
    cfg: cfg,
    defaults: DEFAULT_CFG,
    tones: TONES,
    setCfg: setCfg,
    saveCfg: saveCfg,
    start: start,
    fire: fire,
    stop: stop,
    snooze: snooze,
    test: test,
    unlock: unlock,
    isRinging: function () { return !!ringing; },
    current: function () { return ringing; },
    pending: pendingCount,
    onAction: onAction,
    requestNotify: requestNotify,
    /* 自定义音频 */
    pickAudio: putAudio,
    clearAudio: clearAudio,
    hasAudio: hasAudio,
    audioName: audioName,
    storeState: function () { return idbState; },
    onReady: onReady
  };
})(window);
