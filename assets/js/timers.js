/* ============================================================================
 * timers.js — 计时器（倒计时 + 正计时）
 * ----------------------------------------------------------------------------
 * 参考手机自带计时器的用法：
 *   · 倒计时：一排「常用时长」一点就开始；也能自定义时长后「立即开始」或
 *     「存为常用」；常用的可以删除
 *   · 正计时：新建一个秒表，开始/暂停/继续/重置
 *   · 多个计时器可以同时跑，各自到点各自提醒
 *
 * 持久化的关键：**存绝对时间戳，不存"还剩多少秒"**。
 *   · 倒计时运行中存 endAt（结束时刻），暂停时存 remainMs
 *   · 正计时运行中存 startAt（本段起点），暂停时把本段累加进 accMs
 *   这样页面刷新、切主题、甚至 APK 崩溃自恢复之后，时间依然是准的 ——
 *   如果存"剩余秒数"再每秒减一，setInterval 一旦被节流就会越走越偏。
 *
 * 到点提醒统一交给 Remind.fire()，本模块不碰声音和震动。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LS_CFG = 'dash.timers.cfg';
  var LS_LIST = 'dash.timers.list';
  var LS_PRESET = 'dash.timers.presets';

  var DEFAULT_CFG = { enabled: 1 };

  var DEFAULT_PRESETS = [
    { id: 'p1', label: '1 分钟', sec: 60 },
    { id: 'p3', label: '3 分钟', sec: 180 },
    { id: 'p5', label: '5 分钟', sec: 300 },
    { id: 'p10', label: '10 分钟', sec: 600 },
    { id: 'p15', label: '15 分钟', sec: 900 },
    { id: 'p30', label: '30 分钟', sec: 1800 },
    { id: 'p60', label: '1 小时', sec: 3600 }
  ];

  var cfg = load(LS_CFG, DEFAULT_CFG);
  var list = loadList();
  var presets = loadPresets();

  var tickTimer = null;
  var lastPaint = -1;
  var changeCbs = [];
  var lastFireKey = {};

  /* ---------------------------------------------------------------- 存取 */
  function load(key, def) {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) {}
    var out = {};
    for (var k in def) {
      if (Object.prototype.hasOwnProperty.call(def, k)) {
        out[k] = (c[k] === undefined || c[k] === null) ? def[k] : c[k];
      }
    }
    return out;
  }
  function saveCfg() { try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) {} }
  function setCfg(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) { cfg[k] = patch[k]; }
    }
    saveCfg();
  }

  function loadList() {
    var a = [];
    try { a = JSON.parse(localStorage.getItem(LS_LIST) || '[]') || []; } catch (e) {}
    if (!Array.isArray(a)) { a = []; }
    /* 清洗：丢掉结构不对的条目，避免一个坏数据把整块卡死 */
    return a.filter(function (t) { return t && t.id && (t.kind === 'down' || t.kind === 'up'); });
  }
  function saveList() { try { localStorage.setItem(LS_LIST, JSON.stringify(list)); } catch (e) {} }

  function loadPresets() {
    var a = null;
    try { a = JSON.parse(localStorage.getItem(LS_PRESET) || 'null'); } catch (e) {}
    if (!Array.isArray(a) || !a.length) { return DEFAULT_PRESETS.slice(); }
    return a.filter(function (p) { return p && p.sec > 0; });
  }
  function savePresets() { try { localStorage.setItem(LS_PRESET, JSON.stringify(presets)); } catch (e) {} }

  function newId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  function fireChange() {
    paint();          /* 先把自己的界面刷了，再通知外部 */
    for (var i = 0; i < changeCbs.length; i++) { try { changeCbs[i](); } catch (e) {} }
  }

  /* ---------------------------------------------------------------- 工具 */
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmt(ms) {
    if (!isFinite(ms) || ms < 0) { ms = 0; }
    var s = Math.ceil(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h > 0 ? (h + ':' + pad(m) + ':' + pad(ss)) : (pad(m) + ':' + pad(ss));
  }

  /** 把 "90" / "1:30" / "1:02:30" / "5分" / "2小时" 解析成秒 */
  function parseDur(str) {
    var t = String(str || '').trim().toLowerCase();
    if (!t) { return 0; }
    var m = t.match(/^(\d+)\s*(h|小时|时)/);
    if (m) { return (+m[1]) * 3600; }
    m = t.match(/^(\d+)\s*(m|分钟|分)/);
    if (m) { return (+m[1]) * 60; }
    m = t.match(/^(\d+)\s*(s|秒)/);
    if (m) { return +m[1]; }
    var parts = t.split(':').map(function (x) { return parseInt(x, 10) || 0; });
    if (parts.length === 3) { return parts[0] * 3600 + parts[1] * 60 + parts[2]; }
    if (parts.length === 2) { return parts[0] * 60 + parts[1]; }
    if (/^\d+$/.test(t)) { return +t; }             /* 纯数字当秒 */
    return 0;
  }

  function humanSec(sec) {
    if (sec % 3600 === 0) { return (sec / 3600) + ' 小时'; }
    if (sec % 60 === 0) { return (sec / 60) + ' 分钟'; }
    return fmt(sec * 1000);
  }

  /* ------------------------------------------------------ 当前值计算 */
  /** 返回 { ms, running, done } —— ms 对倒计时是剩余、对正计时是已用 */
  function valueOf(t, now) {
    now = now || Date.now();
    if (t.kind === 'up') {
      var acc = t.accMs || 0;
      if (t.running && t.startAt) { acc += Math.max(0, now - t.startAt); }
      return { ms: acc, running: !!t.running, done: false };
    }
    var remain = t.remainMs || 0;
    if (t.running && t.endAt) { remain = Math.max(0, t.endAt - now); }
    return { ms: remain, running: !!t.running, done: remain <= 0 && !t.running && (t.doneAt > 0) };
  }

  /* ---------------------------------------------------------------- 增删 */
  function addDown(sec, label, autoStart) {
    sec = Math.max(1, Math.round(+sec || 0));
    var now = Date.now();
    var t = {
      id: newId(), kind: 'down',
      label: label || humanSec(sec),
      totalMs: sec * 1000,
      remainMs: sec * 1000,
      endAt: 0, startAt: 0, accMs: 0,
      running: false, doneAt: 0,
      createdAt: now
    };
    list.push(t);
    if (autoStart !== false) { start(t.id); }
    saveList();
    fireChange();
    return t.id;
  }

  function addUp(label) {
    var now = Date.now();
    var t = {
      id: newId(), kind: 'up',
      label: label || '秒表',
      totalMs: 0, remainMs: 0,
      endAt: 0, startAt: now, accMs: 0,
      running: true, doneAt: 0,
      createdAt: now
    };
    list.push(t);
    saveList();
    fireChange();
    return t.id;
  }

  function find(id) {
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }

  function start(id) {
    var t = find(id);
    if (!t) { return; }
    var now = Date.now();
    if (t.kind === 'down') {
      var remain = t.remainMs > 0 ? t.remainMs : t.totalMs;
      if (remain <= 0) { remain = t.totalMs; }
      t.remainMs = remain;
      t.endAt = now + remain;
    } else {
      t.startAt = now;
    }
    t.running = true;
    t.doneAt = 0;
    saveList();
    fireChange();
  }

  function pause(id) {
    var t = find(id);
    if (!t || !t.running) { return; }
    var now = Date.now();
    if (t.kind === 'down') {
      t.remainMs = Math.max(0, (t.endAt || now) - now);
      t.endAt = 0;
    } else {
      t.accMs = (t.accMs || 0) + Math.max(0, now - (t.startAt || now));
      t.startAt = 0;
    }
    t.running = false;
    saveList();
    fireChange();
  }

  function reset(id) {
    var t = find(id);
    if (!t) { return; }
    if (t.kind === 'down') {
      t.remainMs = t.totalMs;
      t.endAt = 0;
    } else {
      t.accMs = 0; t.startAt = 0;
    }
    t.running = false;
    t.doneAt = 0;
    saveList();
    fireChange();
  }

  function remove(id) {
    list = list.filter(function (t) { return t.id !== id; });
    saveList();
    fireChange();
  }

  function clearFinished() {
    var before = list.length;
    list = list.filter(function (t) {
      return !(t.kind === 'down' && !t.running && (t.doneAt > 0));
    });
    if (list.length !== before) { saveList(); fireChange(); }
    return before - list.length;
  }

  /* ---------------------------------------------------------------- 预设 */
  function addPreset(sec, label) {
    sec = Math.max(1, Math.round(+sec || 0));
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].sec === sec) { return presets[i].id; }   /* 已存在就不重复加 */
    }
    var p = { id: 'p' + Date.now().toString(36), label: label || humanSec(sec), sec: sec };
    presets.push(p);
    presets.sort(function (a, b) { return a.sec - b.sec; });
    savePresets();
    fireChange();
    return p.id;
  }

  function removePreset(id) {
    presets = presets.filter(function (p) { return p.id !== id; });
    savePresets();
    fireChange();
  }

  function resetPresets() {
    presets = DEFAULT_PRESETS.slice();
    savePresets();
    fireChange();
  }

  /* ---------------------------------------------------------------- 调度 */
  function runningCount() {
    return list.filter(function (t) { return t.running; }).length;
  }

  /**
   * 入口卡片上的摘要：只负责**倒计时**。
   *
   * 正计时不塞这里 —— 它可能有多个、而且每个都要看读秒，
   * 挤进一张卡片里既放不下也看不清。它们走右边那条独立的条带
   * （见 paintStopwatches），卡片这边只报个数。
   */
  function summary() {
    if (!cfg.enabled) { return { text: '已关闭', n: 0 }; }
    var now = Date.now();
    var best = null, bestMs = Infinity, running = 0, downN = 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t.running) { continue; }
      running++;
      if (t.kind !== 'down') { continue; }
      downN++;
      var v = valueOf(t, now);
      if (v.ms < bestMs) { bestMs = v.ms; best = t; }
    }
    if (!running) {
      var n = list.length;
      return { text: n ? (n + ' 个计时器') : '未启用', n: 0 };
    }
    if (!best) { return { text: running + ' 个正计时', n: running }; }
    return {
      text: fmt(bestMs) + (downN > 1 ? ' +' + (downN - 1) : ''),
      n: running,
      urgent: bestMs <= 60000
    };
  }

  /** 正在跑的正计时列表（最新的排前面） */
  function runningStopwatches() {
    return list.filter(function (t) { return t.kind === 'up' && t.running; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  }

  function tick() {
    if (!cfg.enabled) { return; }
    var now = Date.now();
    var fired = false;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.kind !== 'down' || !t.running || !t.endAt) { continue; }
      if (t.endAt - now > 0) { continue; }
      /* 到点 */
      t.running = false;
      t.remainMs = 0;
      t.doneAt = now;
      t.endAt = 0;
      var key = t.id + ':' + t.doneAt;
      if (!lastFireKey[key]) {
        lastFireKey[key] = 1;
        fire(t);
        fired = true;
      }
    }
    if (fired) { saveList(); fireChange(); }

    /* 只在"显示的秒"变化时重画，避免 4Hz 白刷 DOM */
    var sec = Math.floor(now / 1000);
    if (sec !== lastPaint) { lastPaint = sec; fireChange(); }
  }

  function fire(t) {
    if (!global.Remind) { return; }
    global.Remind.fire({
      kind: 'timer',
      title: '倒计时结束',
      sub: t.label || humanSec((t.totalMs || 0) / 1000),
      timeText: fmt(t.totalMs || 0)
    });
  }

  /** 页面重新可见时补一次：把"刚才被节流/挂起期间到点"的计时器补上提醒 */
  function catchUp() {
    var now = Date.now();
    var missed = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.kind === 'down' && t.running && t.endAt && t.endAt <= now) { missed.push(t); }
    }
    if (!missed.length) { return 0; }
    tick();
    return missed.length;
  }

  /* ---------------------------------------------------------------- 启动
   * ⚠ 这两个函数**不能叫 start / stop** —— 上面已经有一个 start(id) 用来
   *   启动"某一个"计时器了。JS 的函数声明会互相覆盖，同名的话后声明的赢，
   *   Timers.start(id) 就会变成"启动整个模块"并忽略 id，单个计时器永远开始不了。
   *   （这个坑是自检页抓出来的，别改回去。） */
  function boot() {
    if (tickTimer) { return; }
    tickTimer = setInterval(tick, 250);
    /* 从后台恢复时立刻对一次表 */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { catchUp(); }
    });
    window.addEventListener('focus', function () { catchUp(); });
    tick();
  }

  function shutdown() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  /* ---------------------------------------------------------- 界面渲染 */
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var uiKind = 'down';   /* 弹层里当前选的是倒计时还是正计时 */

  function setUiKind(k) {
    uiKind = (k === 'up') ? 'up' : 'down';
    paintModal();
    paintKindSeg();
  }
  function getUiKind() { return uiKind; }

  function paintKindSeg() {
    var btns = document.querySelectorAll('[data-seg="timerKind"] button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-val') === uiKind);
    }
  }

  /**
   * 时钟模块右侧那条「正在跑的正计时」条带。
   * 正计时可能有多个，每个都要看读秒，所以单独给它一块地方，不跟倒计时挤一张卡。
   */
  var SW_MAX = 3;
  function paintStopwatches() {
    var box = $('#clkStopwatches');
    if (!box) { return; }
    if (!cfg.enabled) { box.hidden = true; box.innerHTML = ''; return; }
    var ups = runningStopwatches();
    if (!ups.length) { box.hidden = true; box.innerHTML = ''; return; }

    var now = Date.now();
    var show = ups.slice(0, SW_MAX);
    var extra = ups.length - show.length;
    box.innerHTML = show.map(function (t) {
      return '<button class="sw-chip" data-sw="' + t.id + '" title="点开计时器面板">' +
        '<span class="sw-name">' + esc(t.label) + '</span>' +
        '<span class="sw-time">' + fmt(valueOf(t, now).ms) + '</span>' +
      '</button>';
    }).join('') +
    (extra > 0 ? '<span class="sw-chip more">+' + extra + '</span>' : '');
    box.hidden = false;
  }

  /** 时钟模块里的入口卡片 */
  function paint() {
    paintStopwatches();
    var el = $('[data-timer-val]');
    if (el) {
      var s = summary();
      el.textContent = s.text;
      var card = $('#toolTimer');
      if (card) {
        card.classList.toggle('busy', s.n > 0);
        card.classList.toggle('urgent', !!s.urgent);
      }
    }
    if ($('#timerModal') && $('#timerModal').classList.contains('on')) { paintModal(); }
  }

  function paintModal() {
    var now = Date.now();
    var box = $('#tmRunning');
    if (!box) { return; }

    var rows = list.slice().sort(function (a, b) {
      if (a.running !== b.running) { return a.running ? -1 : 1; }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    /* 倒计时每秒都要重画，但别把用户滚到的位置弹回顶部 */
    var keepScroll = box.scrollTop;

    if (!rows.length) {
      box.innerHTML = '<div class="tm-empty">' +
        (uiKind === 'down' ? '还没有计时器。点下面的常用时长，或输入一个自定义时长。'
                           : '还没有秒表。点下面「新建秒表」开始计时。') + '</div>';
    } else {
      box.innerHTML = rows.map(function (t) {
        var v = valueOf(t, now);
        var cls = 'tm-item' + (t.running ? ' running' : '') +
          (t.kind === 'down' && !t.running && t.doneAt ? ' done' : '');
        var pct = 0;
        if (t.kind === 'down' && t.totalMs > 0) {
          pct = Math.max(0, Math.min(100, 100 - (v.ms / t.totalMs) * 100));
        }
        var sub = t.kind === 'down'
          ? (t.doneAt && !t.running ? '已结束' : (t.running ? '倒计时中' : '已暂停'))
          : (t.running ? '计时中' : '已暂停');
        return '' +
          '<div class="' + cls + '" data-id="' + t.id + '">' +
            '<div class="tm-main">' +
              '<div class="tm-time">' + fmt(v.ms) + '</div>' +
              '<div class="tm-name">' + esc(t.label) + '<span class="tm-sub"> · ' + sub + '</span></div>' +
              (t.kind === 'down' ? '<div class="tm-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' : '') +
            '</div>' +
            '<div class="tm-btns">' +
              '<button data-act="' + (t.running ? 'pause' : 'start') + '" title="' +
                (t.running ? '暂停' : (t.kind === 'down' && !t.remainMs ? '重新开始' : '继续')) + '">' +
                (t.running ? '❚❚' : '▶') + '</button>' +
              '<button data-act="reset" title="重置">↺</button>' +
              '<button data-act="del" title="删除">×</button>' +
            '</div>' +
          '</div>';
      }).join('');
    }

    var ps = $('#tmPresets');
    if (ps) {
      if (uiKind === 'up') {
        ps.innerHTML = '<div class="tm-preset-row"><button class="tm-preset add" data-new-up="1">' +
          '<span class="tp-name">＋ 新建秒表</span></button></div>';
      } else {
        ps.innerHTML = '<div class="tm-preset-row">' +
          presets.map(function (p) {
            return '<span class="tm-preset" data-sec="' + p.sec + '">' +
              '<span class="tp-name">' + esc(p.label) + '</span>' +
              '<button class="tp-del" data-delpreset="' + p.id + '" title="从常用里删除">×</button>' +
            '</span>';
          }).join('') +
          '<button class="tm-preset add" data-new-down="1"><span class="tp-name">＋ 自定义</span></button>' +
          '</div>';
      }
    }

    if (keepScroll) { box.scrollTop = keepScroll; }

    /* 正计时模式下，「自定义时长」那一行是倒计时的东西，不该露出来 */
    var modal = $('#timerModal');
    if (modal) { modal.classList.toggle('tm-up', uiKind === 'up'); }
    var pl = $('#tmPresetLabel');
    if (pl) { pl.textContent = uiKind === 'up' ? '新建' : '常用计时器'; }

    var foot = $('#tmFoot');
    if (foot) {
      var fin = list.filter(function (t) { return t.kind === 'down' && !t.running && t.doneAt; }).length;
      foot.innerHTML = fin ? '<button class="tm-clear" data-clearfinished="1">清掉 ' + fin + ' 个已结束</button>' : '';
    }
    paintKindSeg();
  }

  global.Timers = {
    cfg: cfg,
    defaults: DEFAULT_CFG,
    setCfg: setCfg,
    saveCfg: saveCfg,
    list: function () { return list.slice(); },
    presets: function () { return presets.slice(); },
    addDown: addDown,
    addUp: addUp,
    start: start,
    pause: pause,
    reset: reset,
    remove: remove,
    clearFinished: clearFinished,
    addPreset: addPreset,
    removePreset: removePreset,
    resetPresets: resetPresets,
    parseDur: parseDur,
    humanSec: humanSec,
    fmt: fmt,
    valueOf: valueOf,
    summary: summary,
    runningStopwatches: runningStopwatches,
    runningCount: runningCount,
    catchUp: catchUp,
    setUiKind: setUiKind,
    getUiKind: getUiKind,
    paint: paint,
    paintModal: paintModal,
    onChange: function (fn) { changeCbs.push(fn); },
    boot: boot,
    shutdown: shutdown
  };
})(window);
