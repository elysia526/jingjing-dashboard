/* ============================================================================
 * background.js — 背景模块（第三阶段 · 仅图片，不做视频）
 * ----------------------------------------------------------------------------
 * 【存储：为什么从 localStorage 换成了 IndexedDB】
 *   老方案把图片以 dataURL 塞进 localStorage，被两条硬限制卡死：
 *     · 单键 4MB 左右、全站总量约 5MB —— 高清图存不下几张
 *     · 导入时只能把图压到 1920×1200，在 2K/4K 屏上背景一眼糊
 *   现在改用 IndexedDB（可存几十 MB），并且：
 *     · 导入尺寸跟着**设备实际分辨率**走（见 targetLongEdge）
 *     · file:// 下 IndexedDB 会挂起不可用（老 WebView 的老毛病），
 *       所以带超时探测，失败就自动回退 localStorage —— 功能不丢，只是容量小
 *     · 已有 localStorage 里的图会在启动时**一次性迁移**进 IndexedDB
 *
 *   元数据（列表、尺寸、占用）仍然放在 localStorage：
 *   它很小，而且同步可读，列表界面不用等异步。
 *
 * 【能力】
 *   · 多张图片、按时段（全天 / 白天 / 夜间）自动分组
 *   · 同一时段多张时按间隔轮播，交叉淡入淡出
 *   · 模糊程度、淡化（浅色）/ 压暗（深色）程度可调，保证文字可读
 *   · 可选毛玻璃（backdrop-filter），弱机建议关闭
 *
 * 【异步 API 说明】
 *   涉及图片数据的读写都返回 Promise：getData / getThumb / putImage /
 *   removeItem / clearAll / addFiles / refresh。
 *   列表类信息（list / usedBytes / candidates / currentSlot）保持同步。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LS_CFG = 'dash.bg.cfg';
  var LS_META = 'dash.bg.meta';
  var LS_IMG = 'dash.bg.img.';
  var LS_THUMB = 'dash.bg.thumb.';

  var DB_NAME = 'dash-bg';
  var DB_VER = 1;
  var STORE = 'images';
  var IDB_TIMEOUT = 2500;                 /* file:// 下 open 会一直挂着，超时就放弃 */

  var CAP_LS = 4.5 * 1024 * 1024;         /* localStorage 模式的软上限 */
  var CAP_IDB = 48 * 1024 * 1024;         /* IndexedDB 模式的软上限 */
  var QUALITY = 0.86;
  var THUMB_W = 220;

  var DEFAULT_CFG = {
    mode: 'off',        /* 'off' = 纯色底 | 'image' = 图片背景 */
    blur: 0,            /* 0–30 px */
    veilLight: 82,      /* 浅色：淡化程度（暖米白遮罩） */
    veilDark: 46,       /* 深色：压暗程度（深炭黑遮罩） */
    frosted: 0,         /* 毛玻璃 */
    intervalSec: 0,     /* 0 = 不轮播 */
    dayStart: '06:00',
    nightStart: '18:00',
    res: 'auto',        /* auto | hd(2560) | full(3840) —— 导入长边上限 */
    fadeMs: 900
  };

  var cfg = loadCfg();
  var meta = loadMeta();
  var isDark = false;
  var layers = null;
  var activeLayer = 0;
  var shownId = null;
  var rotTimer = null;
  var tickTimer = null;
  var lastSlot = null;

  var idb = null;                 /* IDBDatabase 或 null（回退 localStorage） */
  var storeState = 'pending';     /* pending | idb | ls */
  var mem = {};                   /* id -> { data, thumb } 内存缓存 */
  var readyCbs = [];

  /* ---------------------------------------------------------------- 存储 */
  function loadCfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(LS_CFG) || '{}') || {}; } catch (e) {}
    var out = {};
    for (var k in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) {
        out[k] = (c[k] === undefined || c[k] === null) ? DEFAULT_CFG[k] : c[k];
      }
    }
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

  function loadMeta() {
    var m = [];
    try { m = JSON.parse(localStorage.getItem(LS_META) || '[]') || []; } catch (e) {}
    return Array.isArray(m) ? m : [];
  }

  function saveMeta() {
    try { localStorage.setItem(LS_META, JSON.stringify(meta)); } catch (e) {}
  }

  function usedBytes() {
    var n = 0;
    for (var i = 0; i < meta.length; i++) { n += meta[i].bytes || 0; }
    return n;
  }

  function softCap() { return storeState === 'idb' ? CAP_IDB : CAP_LS; }

  function newId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* --------------------------------------------------- IndexedDB 薄封装 */

  function openIdb() {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(db) { if (!settled) { settled = true; resolve(db || null); } }
      try {
        if (!global.indexedDB) { finish(null); return; }
        var req = global.indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = function () { finish(req.result); };
        req.onerror = function () { finish(null); };
        req.onblocked = function () { finish(null); };
        /* file:// 页面下 open 会永远不回调，靠这个超时兜底 */
        setTimeout(function () { finish(null); }, IDB_TIMEOUT);
      } catch (e) { finish(null); }
    });
  }

  /** 在一个事务里跑一次操作，返回 Promise */
  function tx(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!idb) { reject(new Error('no idb')); return; }
      var t, store, req;
      try {
        t = idb.transaction(STORE, mode);
        store = t.objectStore(STORE);
        req = fn(store);
      } catch (e) { reject(e); return; }
      t.oncomplete = function () { resolve(req ? req.result : undefined); };
      t.onerror = function () { reject(t.error || new Error('idb tx error')); };
      t.onabort = function () { reject(t.error || new Error('idb tx abort')); };
    });
  }

  function idbPut(rec) { return tx('readwrite', function (s) { return s.put(rec); }).then(function () { return true; }); }
  function idbGet(id) { return tx('readonly', function (s) { return s.get(id); }).then(function (r) { return r || null; }); }
  function idbDel(id) { return tx('readwrite', function (s) { return s.delete(id); }).then(function () { return true; }); }
  function idbClear() { return tx('readwrite', function (s) { return s.clear(); }).then(function () { return true; }); }
  function idbKeys() { return tx('readonly', function (s) { return s.getAllKeys(); }).then(function (k) { return k || []; }); }

  /* --------------------------------------------------------- 统一读写口 */

  function lsGetRec(id) {
    var d = null, t = '';
    try { d = localStorage.getItem(LS_IMG + id); t = localStorage.getItem(LS_THUMB + id) || ''; } catch (e) {}
    return d ? { id: id, data: d, thumb: t } : null;
  }

  function lsDelRec(id) {
    try {
      localStorage.removeItem(LS_IMG + id);
      localStorage.removeItem(LS_THUMB + id);
    } catch (e) {}
  }

  /** 读一张图（带内存缓存）。IDB 里没有但 localStorage 里有，就顺手补迁过去 */
  /**
   * 读一张图，返回 **{ rec, missing }**。
   *
   * `missing` 只在"确实查过、确实没有"时才为 true。
   * 这一点非常关键 —— 调用方靠它决定要不要清掉元数据，而：
   *
   *   · 启动早期存储还没就绪（storeState === 'pending'）时读不到，**不是**数据丢了
   *   · IDB 读取报错时也**不是**数据丢了
   *
   * v1.9 就是在这儿翻的车：start() 先 refresh() 再开存储，第二次启动时
   * idb 还是 null、图却在 IndexedDB 里 → 读不到 → 被判成幽灵条目删掉，
   * 而且 dash.bg.seeded 已标记种过，内置图再也回不来。
   */
  function loadRecEx(id) {
    if (mem[id]) { return Promise.resolve({ rec: mem[id], missing: false }); }
    if (!idb) {
      /* ⚠ 这里**永远不能**返回 missing:true。
         idb 为空有两种情况：还没就绪，或者 IndexedDB 压根没开成（file:// 会挂起、
         老设备可能超时）。这两种情况下 localStorage 里没有，
         **并不代表数据丢了** —— 它很可能好好躺在 IndexedDB 里，只是这次够不着。
         要是据此把元数据删了，每次启动都会删一遍再种一遍，白折腾还可能真丢数据。 */
      var r = lsGetRec(id);
      if (r) { mem[id] = r; }
      return Promise.resolve({ rec: r, missing: false });
    }
    return idbGet(id).then(function (rec) {
      if (rec && rec.data) { mem[id] = rec; return { rec: rec, missing: false }; }
      var legacy = lsGetRec(id);
      if (!legacy) { return { rec: null, missing: true }; }
      mem[id] = legacy;
      idbPut(legacy).then(function () { lsDelRec(id); }).catch(function () {});
      return { rec: legacy, missing: false };
    }).catch(function () {
      /* IDB 读失败是"读不了"，不是"没有" —— 绝不能据此删数据 */
      var legacy = lsGetRec(id);
      if (legacy) { mem[id] = legacy; }
      return { rec: legacy, missing: false };
    });
  }

  function loadRec(id) {
    return loadRecEx(id).then(function (r) { return r.rec; });
  }

  /** 写一张图 */
  function putRec(id, data, thumb) {
    var rec = { id: id, data: data, thumb: thumb || '' };
    mem[id] = rec;
    if (!idb) {
      try {
        localStorage.setItem(LS_IMG + id, data);
        localStorage.setItem(LS_THUMB + id, rec.thumb);
        return Promise.resolve(true);
      } catch (e) { return Promise.reject(e); }
    }
    return idbPut(rec);
  }

  function delRec(id) {
    delete mem[id];
    if (!idb) { lsDelRec(id); return Promise.resolve(true); }
    return idbDel(id).catch(function () { return true; }).then(function () { lsDelRec(id); return true; });
  }

  function dropAllRecs() {
    var ids = meta.map(function (m) { return m.id; });
    mem = {};
    function purgeLs() {
      for (var i = 0; i < ids.length; i++) { lsDelRec(ids[i]); }
    }
    if (!idb) { purgeLs(); return Promise.resolve(true); }
    return idbClear().catch(function () { return true; }).then(function () { purgeLs(); return true; });
  }

  /* -------------------------------------------------------- 启动与迁移 */

  /**
   * 把 localStorage 里遗留的图搬进 IndexedDB。
   *
   * 这里**直接扫 localStorage 的键**，而不是遍历 meta 列表：
   * 万一 meta 曾经被写坏过、或图片比元数据先落盘，扫键能把它们全都救回来，
   * 也不会留下永远迁不动的"幽灵图"。
   */
  function migrate() {
    var ids = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(LS_IMG) === 0) { ids.push(k.slice(LS_IMG.length)); }
      }
    } catch (e) { return Promise.resolve(0); }
    if (!ids.length) { return Promise.resolve(0); }

    return idbKeys().then(function (keys) {
      var have = {};
      for (var i = 0; i < keys.length; i++) { have[keys[i]] = 1; }
      var jobs = [];
      for (var j = 0; j < ids.length; j++) {
        (function (id) {
          if (have[id]) { lsDelRec(id); return; }
          var rec = lsGetRec(id);
          if (!rec) { return; }
          jobs.push(idbPut(rec).then(function () {
            lsDelRec(id);
            ensureMeta(id, rec.data.length);
          }).catch(function () {}));
        })(ids[j]);
      }
      return Promise.all(jobs).then(function () {
        if (jobs.length) { saveMeta(); }
        return jobs.length;
      });
    }).catch(function () { return 0; });
  }

  /** 迁移时如果发现某张图没有对应的元数据条目，补一条，别让它变成孤儿 */
  function ensureMeta(id, bytes) {
    for (var i = 0; i < meta.length; i++) { if (meta[i].id === id) { return; } }
    meta.push({
      id: id, name: '已恢复的图片', slot: 'all', w: 0, h: 0,
      bytes: bytes || 0, addedAt: Date.now()
    });
  }

  /**
   * 打开存储。
   *
   * ⚠ 超时**不等于判死刑**，只是"先别干等了"：
   *   超过 IDB_TIMEOUT 还没开好，就先按 localStorage 模式把界面跑起来；
   *   但 IndexedDB 稍后真的开成功了，仍然会切过去并完成迁移。
   *   老设备上第一次建库可能慢一点，不该因此永远用不上大容量。
   */
  function initStore() {
    var full = openIdb().then(function (db) {
      idb = db;
      storeState = db ? 'idb' : 'ls';
      return db ? migrate() : 0;
    }).then(function (moved) {
      notify(moved);
      return moved;
    });
    var early = new Promise(function (res) {
      setTimeout(function () {
        if (storeState === 'pending') { storeState = 'ls'; notify(0); }
        res();
      }, IDB_TIMEOUT);
    });
    return Promise.race([early, full]).then(function () {
      return { state: storeState === 'pending' ? 'ls' : storeState };
    });
  }

  function notify(moved) {
    var s = storeState === 'pending' ? 'ls' : storeState;
    for (var i = 0; i < readyCbs.length; i++) {
      try { readyCbs[i](s, moved || 0); } catch (e) {}
    }
  }

  /** 注册存储状态监听。可能被调用多次（先降级跑、后升级到 IndexedDB） */
  function onReady(fn) {
    readyCbs.push(fn);
    if (storeState !== 'pending') { try { fn(storeState, 0); } catch (e) {} }
  }

  /* ------------------------------------------------------------ 压缩导入 */

  /** 导入长边上限：跟着设备实际分辨率走，避免高清屏上背景发糊 */
  function targetLongEdge() {
    var r = cfg.res || 'auto';
    if (r === 'hd') { return 2560; }
    if (r === 'full') { return 3840; }
    var dpr = global.devicePixelRatio || 1;
    var sw = 1920;
    try {
      var s = global.screen || {};
      sw = Math.max(+s.width || 0, +s.height || 0) || 1920;
    } catch (e) {}
    return Math.max(1920, Math.min(3840, Math.round(sw * dpr)));
  }

  /**
   * 把一张图压到目标尺寸，产出 { data, thumb, w, h, bytes }。
   * src 既可以是 objectURL（用户选的文件），也可以是 dataURL（内置图）——
   * 两种都画进 canvas 都不会污染，所以 toDataURL() 都能用。
   */
  function compressSrc(src, mime, isObjectUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      function cleanup() { if (isObjectUrl) { try { URL.revokeObjectURL(src); } catch (e) {} } }
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          var cap = targetLongEdge();
          var r = Math.min(1, cap / Math.max(w, h));     /* 只缩不放，避免把小图放大糊掉 */
          var tw = Math.max(1, Math.round(w * r));
          var th = Math.max(1, Math.round(h * r));
          var c = document.createElement('canvas');
          c.width = tw; c.height = th;
          var g = c.getContext('2d');
          g.fillStyle = '#ffffff';                    /* PNG 透明区域在 JPEG 下会变黑，先铺白底 */
          g.drawImage(img, 0, 0, tw, th);
          var isPng = /png/i.test(mime || '');
          var out = isPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', QUALITY);
          if (isPng && out.length > 900 * 1024) { out = c.toDataURL('image/jpeg', QUALITY); }

          /* 顺手做一张小缩略图，设置面板列表用它，避免为了缩略图去解码整张大图 */
          var tw2 = THUMB_W, th2 = Math.max(1, Math.round(tw2 * th / tw));
          var tc = document.createElement('canvas');
          tc.width = tw2; tc.height = th2;
          var tg = tc.getContext('2d');
          tg.fillStyle = '#ffffff'; tg.fillRect(0, 0, tw2, th2);
          tg.drawImage(img, 0, 0, tw2, th2);
          var thumb = tc.toDataURL('image/jpeg', 0.7);

          cleanup();
          resolve({ data: out, thumb: thumb, w: tw, h: th, bytes: out.length, srcType: mime });
        } catch (e) {
          cleanup();
          reject(e);
        }
      };
      img.onerror = function () { cleanup(); reject(new Error('图片解码失败')); };
      img.src = src;
    });
  }

  function compress(file) {
    if (!file || !/^image\//.test(file.type || '')) {
      return Promise.reject(new Error('不是图片文件'));
    }
    return compressSrc(URL.createObjectURL(file), file.type, true);
  }

  /* ------------------------------------------------------- 内置背景图种子 */
  var LS_SEEDED = 'dash.bg.seeded';
  var LS_REMOVED = 'dash.bg.removed';
  var BI_PREFIX = 'bi_';

  function readMap(key) {
    var m = {};
    try { m = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) {}
    return (m && typeof m === 'object') ? m : {};
  }
  function writeMap(key, m) {
    try { localStorage.setItem(key, JSON.stringify(m)); } catch (e) {}
  }

  /** 记下"用户主动删掉了这个内置图"，之后不再自动种回来 */
  function markRemoved(id) {
    if (id.indexOf(BI_PREFIX) !== 0) { return; }
    var rem = readMap(LS_REMOVED);
    rem[id.slice(BI_PREFIX.length)] = 1;
    writeMap(LS_REMOVED, rem);
  }

  /**
   * 把随应用分发的内置图导入背景库。
   *
   * 判定条件不是"种过没有"，而是**"库里现在有没有"**：
   *   · 用户主动删过（dash.bg.removed）→ 不再种回来
   *   · 库里已经有 → 跳过
   *   · 其它情况（从没种过 / 数据以任何原因丢了）→ 种一份
   *
   * 这样它自带**自愈**能力：万一因为换 origin、配额、崩溃之类把数据弄丢了，
   * 下次启动会自动补回来，而不是像 v1.9 那样一次丢了就永远没了。
   */
  function seedBuiltin() {
    var list = (global.DASH_BUILTIN_BG || []).filter(function (b) { return b && b.data && b.id; });
    if (!list.length) { return Promise.resolve(0); }

    var done = readMap(LS_SEEDED);
    var removed = readMap(LS_REMOVED);
    /* 库里本来就是空的（首次安装 / 数据全丢）—— 补种完顺手把背景切成图片。
       要是用户自己已经存了图、还特意选了纯色底，那就别动人家的设置。 */
    var wasEmpty = meta.length === 0;
    var added = 0, switched = false, i = 0;

    /** 把一张内置图压好、写进当前存储，并登记元数据 */
    function plant(b, id) {
      var firstTime = !done[b.id];
      return compressSrc(b.data, 'image/jpeg', false).then(function (r) {
        if (usedBytes() + r.bytes > softCap()) {
          /* 空间不够：标记成已种过，免得每次启动都白试一遍 */
          done[b.id] = 1;
          writeMap(LS_SEEDED, done);
          return false;
        }
        return putRec(id, r.data, r.thumb).then(function () {
          /* 去重：元数据里可能已经有一条同 id 的（数据在别的存储里够不着），
             直接 push 的话列表里会出现两张一模一样的 */
          meta = meta.filter(function (m) { return m.id !== id; });
          meta.push({
            id: id, name: b.name || '内置背景',
            slot: 'all', w: r.w, h: r.h, bytes: r.bytes,
            addedAt: Date.now(), builtin: 1
          });
          done[b.id] = 1;
          writeMap(LS_SEEDED, done);
          added++;
          if (firstTime || wasEmpty) { switched = true; }
          return true;
        }).catch(function () { return false; });   /* 写入失败不标记，下次再试 */
      }).catch(function () {
        done[b.id] = 1;                              /* 图本身解不开，别再试了 */
        writeMap(LS_SEEDED, done);
        return false;
      });
    }

    function step() {
      if (i >= list.length) {
        saveMeta();
        /* 只有"头一回种"才顺手把背景模式切成「图片」——
           不然内置壁纸躺在库里不显示，用户会以为没生效。
           自愈补种时不动模式（用户可能自己选了纯色底）。 */
        if (switched && cfg.mode === 'off') { setCfg({ mode: 'image' }); }
        return refresh(true).then(function () {
          schedule();                 /* 模式变了，轮播/跨时段定时器要跟着重建 */
          return added;
        });
      }
      var b = list[i++];
      if (removed[b.id]) { return step(); }          /* 用户删过，别再种 */
      var id = BI_PREFIX + b.id;
      /* ⚠ 判定标准是"库里现在有没有、这次读不读得出来"，**不是**"种过没有"。
         这样它自带自愈能力：元数据丢了、换了 origin、配额问题把数据弄没了，
         下次启动都会自动补回来，而不是像 v1.9 那样一次丢了就永远没了。 */
      return loadRecEx(id).then(function (r) {
        if (r.rec && r.rec.data) {
          /* 数据还在、元数据却没了（meta 被写坏 / 被清过）→ 补一条元数据。
             不然图明明躺在库里，列表和背景却都看不见它。 */
          var found = false;
          for (var j = 0; j < meta.length; j++) { if (meta[j].id === id) { found = true; break; } }
          if (!found) {
            meta.push({
              id: id, name: b.name || '内置背景', slot: 'all',
              w: b.w || 0, h: b.h || 0,
              bytes: (r.rec.data || '').length,
              addedAt: Date.now(), builtin: 1
            });
            saveMeta();
            added++;                 /* 让调用方知道有变化，好刷新界面 */
          }
          return step();
        }
        return plant(b, id).then(step);
      });
    }
    return step();
  }

  /** 导入若干文件，逐个压缩入库 */
  function addFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    var added = [], failed = [], i = 0;

    function next() {
      if (i >= arr.length) {
        saveMeta();
        return refreshAndSchedule().then(function () {
          return { added: added, failed: failed, used: usedBytes(), cap: softCap() };
        });
      }
      var f = arr[i++];
      return compress(f).then(function (r) {
        if (usedBytes() + r.bytes > softCap()) {
          failed.push({ name: f.name, why: '存储空间不足（当前上限约 ' +
            (softCap() / 1048576).toFixed(1) + ' MB）' });
          return next();
        }
        var id = newId();
        return putRec(id, r.data, r.thumb).then(function () {
          meta.push({
            id: id,
            name: (f.name || '未命名').replace(/\.[^.]+$/, '').slice(0, 24),
            slot: 'all',
            w: r.w, h: r.h,
            bytes: r.bytes,
            addedAt: Date.now()
          });
          added.push(id);
          return next();
        }).catch(function () {
          failed.push({ name: f.name, why: '写入失败，可能是存储空间已满' });
          return next();
        });
      }).catch(function (e) {
        failed.push({ name: f.name, why: (e && e.message) || '处理失败' });
        return next();
      });
    }
    return next();
  }

  function removeItem(id) { return removeItemEx(id, false); }

  /** 只把这条从库里抹掉，**不**触发重绘（给 refresh 内部循环用，避免递归） */
  function dropGhost(id) {
    meta = meta.filter(function (m) { return m.id !== id; });
    saveMeta();
    if (shownId === id) { shownId = null; }
    return delRec(id).then(function () { return true; });
  }

  /**
   * @param {boolean} fromGhost 这条是"元数据还在、数据确实没了"被清掉的。
   *   那种情况**不能**记成"用户删过" —— 否则内置图就永远回不来了，
   *   而我们要的恰恰是让它下次启动自动补种。
   */
  function removeItemEx(id, fromGhost) {
    if (!fromGhost) { markRemoved(id); }   /* 用户主动删的才记一笔 */
    return dropGhost(id).then(function () { return refreshAndSchedule(); });
  }

  function setSlot(id, slot) {
    for (var i = 0; i < meta.length; i++) {
      if (meta[i].id === id) { meta[i].slot = slot; }
    }
    saveMeta();
    return refreshAndSchedule();
  }

  function renameItem(id, name) {
    for (var i = 0; i < meta.length; i++) {
      if (meta[i].id === id) { meta[i].name = String(name || '').slice(0, 24); }
    }
    saveMeta();
  }

  function clearAll() {
    shownId = null;
    /* 「清空全部」也是用户的明确意图 —— 内置图一并记成"用户删过"，
       否则下次启动它们又会自己长回来。 */
    for (var i = 0; i < meta.length; i++) { markRemoved(meta[i].id); }
    return dropAllRecs().then(function () {
      meta = [];
      saveMeta();
      return refreshAndSchedule();
    });
  }

  /* ------------------------------------------------------------ 时段判定 */
  function toMinutes(hhmm) {
    var p = String(hhmm || '00:00').split(':');
    return (+p[0] || 0) * 60 + (+p[1] || 0);
  }

  function currentSlot(now) {
    now = now || new Date();
    var cur = now.getHours() * 60 + now.getMinutes();
    var d = toMinutes(cfg.dayStart), n = toMinutes(cfg.nightStart);
    if (d === n) { return 'day'; }
    if (d < n) { return (cur >= d && cur < n) ? 'day' : 'night'; }
    /* 跨零点：白天从 d 到次日 n */
    return (cur >= d || cur < n) ? 'day' : 'night';
  }

  function candidates() {
    var slot = currentSlot();
    return meta.filter(function (m) { return m.slot === 'all' || m.slot === slot; });
  }

  /* ---------------------------------------------------------------- 渲染 */
  function ensureLayers() {
    if (layers) { return layers; }
    var a = document.getElementById('bgA'), b = document.getElementById('bgB');
    layers = (a && b) ? [a, b] : null;
    return layers;
  }

  function applyStyle() {
    var root = document.documentElement;
    root.style.setProperty('--bg-blur', (cfg.blur || 0) + 'px');
    var veil = isDark ? cfg.veilDark : cfg.veilLight;
    var rgb = isDark ? '18,20,23' : '244,242,236';
    root.style.setProperty('--bg-veil', 'rgba(' + rgb + ',' + (Math.max(0, Math.min(100, veil)) / 100) + ')');
    var bg = document.getElementById('bg');
    if (bg) {
      bg.classList.toggle('on', cfg.mode === 'image');
      bg.classList.toggle('frosted', !!cfg.frosted);
    }
  }

  function show(dataUrl) {
    var L = ensureLayers();
    if (!L) { return; }
    if (!dataUrl) {
      L[0].classList.remove('on');
      L[1].classList.remove('on');
      return;
    }
    var nxt = 1 - activeLayer;
    L[nxt].style.transitionDuration = (cfg.fadeMs || 900) + 'ms';
    L[nxt].style.backgroundImage = 'url("' + dataUrl + '")';
    void L[nxt].offsetWidth;                 /* 强制 reflow，保证过渡真的跑 */
    L[nxt].classList.add('on');
    L[activeLayer].classList.remove('on');
    activeLayer = nxt;
  }

  /** 选出当前该显示的图（顺序轮换）。返回 Promise */
  function refresh(force) {
    applyStyle();
    if (cfg.mode !== 'image') { show(null); shownId = null; return Promise.resolve(null); }
    var cand = candidates();
    if (!cand.length) { show(null); shownId = null; return Promise.resolve(null); }
    /* 非强制刷新由轮播定时器调用：间隔开启时必须继续走到下一张，
       只有轮播关闭时才保留当前图，避免把定时 tick 变成空操作。 */
    if (!force && !(+cfg.intervalSec > 0) && shownId &&
        cand.some(function (m) { return m.id === shownId; })) {
      return Promise.resolve(shownId);
    }
    var pos = 0;
    for (var i = 0; i < cand.length; i++) {
      if (cand[i].id === shownId) { pos = i + 1; }
    }

    /* 从 pos 开始挨个试。某一张这次读不出来（幽灵条目 / 正在迁移 / 存储够不着）
       不该让整个背景空着 —— 换下一张。
       只有"确实查过、确实没有"（missing）才顺手把元数据清掉，而且用 dropGhost
       而不是 removeItem，避免在循环里递归触发 refresh。 */
    var order = [];
    for (var k = 0; k < cand.length; k++) { order.push(cand[(pos + k) % cand.length]); }

    function tryAt(idx) {
      if (idx >= order.length) { return null; }
      var pick = order[idx];
      return loadRecEx(pick.id).then(function (r) {
        if (r.rec && r.rec.data) {
          shownId = pick.id;
          show(r.rec.data);
          return pick.id;
        }
        if (!r.missing) { return tryAt(idx + 1); }
        return dropGhost(pick.id).then(function () { return tryAt(idx + 1); });
      });
    }
    return tryAt(0);
  }

  /* ---------------------------------------------------------------- 调度 */
  function schedule() {
    stop();
    if (cfg.mode !== 'image') { return; }
    var cand = candidates();
    if (cand.length > 1 && cfg.intervalSec > 0) {
      rotTimer = setInterval(function () { refresh(false); }, cfg.intervalSec * 1000);
    }
    /* 每分钟看一眼有没有跨时段，跨了就立刻换 */
    lastSlot = currentSlot();
    tickTimer = setInterval(function () {
      var s = currentSlot();
      if (s !== lastSlot) { lastSlot = s; refresh(true); }
    }, 60 * 1000);
  }

  function stop() {
    if (rotTimer) { clearInterval(rotTimer); rotTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  /** 候选图片变化后重刷当前图，并按新的候选数重建调度。 */
  function refreshAndSchedule() {
    return refresh(true).then(function (id) {
      schedule();
      return id;
    });
  }

  /** 主题切换时重新算遮罩颜色 */
  function setTheme(t) {
    isDark = (t === 'dark');
    applyStyle();
  }

  /** 启动：先按"还没有存储"的状态渲染一次（界面立刻有反应），再异步开存储并重刷 */
  function start(theme) {
    isDark = (theme === 'dark');
    refresh(true);
    schedule();
    initStore().then(function () {
      /* 存储好了之后再种内置背景图（要等 IndexedDB 就绪） */
      return seedBuiltin();
    }).then(function (n) {
      if (n) { notify(0); }         /* 让界面把新种进来的内置图刷出来 */
      refresh(true);
      schedule();
    });
  }

  global.Background = {
    cfg: cfg,
    defaults: DEFAULT_CFG,
    setCfg: setCfg,
    saveCfg: saveCfg,
    list: function () { return meta.slice(); },
    getData: function (id) { return loadRec(id).then(function (r) { return r ? r.data : null; }); },
    getThumb: function (id) { return loadRec(id).then(function (r) { return r ? (r.thumb || '') : ''; }); },
    peekThumb: function (id) { return (mem[id] && mem[id].thumb) || ''; },
    putImage: putRec,
    usedBytes: usedBytes,
    softCap: softCap,
    targetLongEdge: targetLongEdge,
    addFiles: addFiles,
    removeItem: removeItem,
    setSlot: setSlot,
    renameItem: renameItem,
    clearAll: clearAll,
    seedBuiltin: seedBuiltin,
    currentSlot: currentSlot,
    candidates: candidates,
    refresh: refresh,
    schedule: schedule,
    start: start,
    stop: stop,
    setTheme: setTheme,
    applyStyle: applyStyle,
    onReady: onReady,
    storeState: function () { return storeState; }
  };
})(window);
