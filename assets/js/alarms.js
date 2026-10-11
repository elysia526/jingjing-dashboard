/* ============================================================================
 * alarms.js — 闹钟
 * ----------------------------------------------------------------------------
 * 支持：一次 / 每天 / 指定星期 / 工作日 / 周末；标签；单条开关；多条共存。
 *
 * 判定方式：每秒看一眼"当前 HH:MM 是否命中某条闹钟"，并且用
 * `lastFired = 'YYYY-MM-DD HH:MM'` 去重 —— 这样即使 setInterval 被节流、
 * 某一秒被跳过，只要那一分钟内还有任意一次 tick 命中就不会漏响；
 * 而重复 tick 又不会重复响。
 *
 * 页面重新打开时做一次**补响**：如果某条闹钟的响铃时刻在过去 5 分钟内、
 * 且当时没响过，就立刻补一次（闹钟晚响总比不响好）；超过 5 分钟则记一条
 * "错过"提示放到面板里，不惊动用户。
 *
 * 到点提醒统一交给 Remind.fire()。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LS_CFG = 'dash.alarms.cfg';
  var LS_LIST = 'dash.alarms.list';

  var DEFAULT_CFG = { enabled: 1 };
  var CATCHUP_MS = 5 * 60 * 1000;      /* 5 分钟内补响 */
  var DAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
  var WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];   /* 界面上从周一排到周日 */

  var cfg = load(LS_CFG, DEFAULT_CFG);
  var list = loadList();

  var tickTimer = null;
  var lastPaint = -1;
  var changeCbs = [];
  var editingId = null;

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
    return a.filter(function (x) {
      return x && x.id && typeof x.hh === 'number' && typeof x.mm === 'number';
    }).map(function (x) {
      if (!Array.isArray(x.days)) { x.days = []; }
      return x;
    });
  }
  function saveList() { try { localStorage.setItem(LS_LIST, JSON.stringify(list)); } catch (e) {} }

  function newId() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fireChange() {
    paint();          /* 先把自己的界面刷了，再通知外部 */
    for (var i = 0; i < changeCbs.length; i++) { try { changeCbs[i](); } catch (e) {} }
  }

  /* ---------------------------------------------------------------- 工具 */
  function keyOf(d, hh, mm) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(hh) + ':' + pad(mm);
  }

  function daysText(a) {
    var d = a.days || [];
    if (!d.length) { return '仅一次'; }
    if (d.length === 7) { return '每天'; }
    if (d.length === 5 && [1, 2, 3, 4, 5].every(function (x) { return d.indexOf(x) >= 0; })) { return '工作日'; }
    if (d.length === 2 && d.indexOf(0) >= 0 && d.indexOf(6) >= 0) { return '周末'; }
    return WEEK_ORDER.filter(function (x) { return d.indexOf(x) >= 0; })
      .map(function (x) { return '周' + DAY_CN[x]; }).join(' ');
  }

  /** 下一次响铃时刻；永不响返回 null */
  function nextAt(a, now) {
    if (!a.on) { return null; }
    now = now || new Date();
    var days = (a.days && a.days.length) ? a.days : null;
    for (var d = 0; d < 8; d++) {
      var cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, a.hh, a.mm, 0, 0);
      if (cand.getTime() <= now.getTime()) { continue; }
      if (!days) { return cand; }
      if (days.indexOf(cand.getDay()) >= 0) { return cand; }
    }
    return null;
  }

  function relDay(when, now) {
    now = now || new Date();
    var a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var b = new Date(when.getFullYear(), when.getMonth(), when.getDate());
    var diff = Math.round((b - a) / 86400000);
    if (diff === 0) { return '今天'; }
    if (diff === 1) { return '明天'; }
    if (diff === 2) { return '后天'; }
    return '周' + DAY_CN[when.getDay()];
  }

  /* ---------------------------------------------------------------- 增删 */
  function add(hh, mm, days, label, on) {
    var a = {
      id: newId(),
      hh: Math.max(0, Math.min(23, Math.round(+hh || 0))),
      mm: Math.max(0, Math.min(59, Math.round(+mm || 0))),
      days: (days || []).slice(),
      label: String(label || '').slice(0, 16),
      on: on === 0 ? 0 : 1,
      lastFired: '',
      createdAt: Date.now()
    };
    list.push(a);
    list.sort(function (x, y) { return (x.hh * 60 + x.mm) - (y.hh * 60 + y.mm); });
    saveList();
    fireChange();
    return a.id;
  }

  function find(id) {
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }

  function update(id, patch) {
    var a = find(id);
    if (!a) { return; }
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) { a[k] = patch[k]; }
    }
    if (patch.hh !== undefined || patch.mm !== undefined) { a.lastFired = ''; }
    saveList();
    fireChange();
  }

  function remove(id) {
    list = list.filter(function (x) { return x.id !== id; });
    if (editingId === id) { editingId = null; }
    saveList();
    fireChange();
  }

  function toggle(id, on) {
    var a = find(id);
    if (!a) { return; }
    a.on = on ? 1 : 0;
    if (a.on) { a.lastFired = ''; }
    saveList();
    fireChange();
  }

  function clearAll() {
    list = [];
    editingId = null;
    saveList();
    fireChange();
  }

  /* ---------------------------------------------------------------- 调度 */
  function summary() {
    if (!cfg.enabled) { return { text: '已关闭', n: 0 }; }
    var now = new Date();
    var best = null, bestT = Infinity, on = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].on) { continue; }
      on++;
      var w = nextAt(list[i], now);
      if (w && w.getTime() < bestT) { bestT = w.getTime(); best = w; }
    }
    if (!on) { return { text: list.length ? '全部已关' : '未启用', n: 0 }; }
    return {
      text: pad(best.getHours()) + ':' + pad(best.getMinutes()) + ' ' + relDay(best, now),
      n: on
    };
  }

  function fire(a) {
    if (!global.Remind) { return; }
    global.Remind.fire({
      kind: 'alarm',
      title: '闹钟',
      sub: (a.label ? a.label + ' · ' : '') + daysText(a),
      timeText: pad(a.hh) + ':' + pad(a.mm)
    });
  }

  function check(now) {
    if (!cfg.enabled) { return; }
    var fired = false;
    var hh = now.getHours(), mm = now.getMinutes();
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a.on) { continue; }
      if (a.hh !== hh || a.mm !== mm) { continue; }
      var key = keyOf(now, hh, mm);
      if (a.lastFired === key) { continue; }
      if (a.days && a.days.length && a.days.indexOf(now.getDay()) < 0) { continue; }
      a.lastFired = key;
      if (!a.days || !a.days.length) { a.on = 0; }   /* 单次：响完自动关 */
      fire(a);
      fired = true;
    }
    if (fired) { saveList(); fireChange(); }
  }

  /**
   * 页面重新打开时的补响。
   * 5 分钟内 → 立刻补一次；更早 → 记一条"错过"提示，不打扰。
   */
  function catchUp() {
    if (!cfg.enabled) { return 0; }
    var now = new Date();
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a.on) { continue; }
      var today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), a.hh, a.mm, 0, 0);
      var key = keyOf(today, a.hh, a.mm);
      if (a.lastFired === key) { continue; }
      if (a.days && a.days.length && today.getDay() !== now.getDay()) { continue; }
      if (a.days && a.days.length && a.days.indexOf(today.getDay()) < 0) { continue; }
      var diff = now.getTime() - today.getTime();
      if (diff < 0) { continue; }
      a.lastFired = key;
      /* 单次闹钟响过就关掉 —— 补响这条路也必须照做，
         否则它明天还会再响一次，等于凭空多出来一个闹钟 */
      if (!a.days || !a.days.length) { a.on = 0; }
      if (diff <= CATCHUP_MS) {
        fire(a);
        n++;
      } else {
        cfg.missedAt = today.getTime();
        cfg.missedText = pad(a.hh) + ':' + pad(a.mm) + (a.label ? ' ' + a.label : '');
      }
    }
    saveList(); saveCfg(); fireChange();
    return n;
  }

  function tick() {
    var now = new Date();
    check(now);
    var sec = Math.floor(now.getTime() / 1000);
    if (sec !== lastPaint) { lastPaint = sec; fireChange(); }
  }

  function start() {
    if (tickTimer) { return; }
    tickTimer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { tick(); }
    });
    window.addEventListener('focus', function () { tick(); });
    tick();
  }

  function stop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  /* ---------------------------------------------------------- 界面渲染 */
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function paint() {
    var el = $('[data-alarm-val]');
    if (el) {
      var s = summary();
      el.textContent = s.text;
      var card = $('#toolAlarm');
      if (card) { card.classList.toggle('busy', s.n > 0); }
    }
    var m = $('#alarmModal');
    if (m && m.classList.contains('on')) { paintModal(); }
  }

  /** 列表内容指纹：没变就不重画，免得每秒重建 DOM 把滚动位置弹回顶部 */
  function listSig() {
    var now = new Date();
    return list.map(function (a) {
      var w = nextAt(a, now);
      return a.id + '|' + a.hh + ':' + a.mm + '|' + a.on + '|' + (a.label || '') +
        '|' + (a.days || []).join(',') + '|' + (w ? w.getTime() : 0);
    }).join('#');
  }
  var lastSig = null;

  function paintModal(forceList) {
    var box = $('#alList');
    if (!box) { return; }
    var now = new Date();
    var sig = listSig();
    if (!forceList && sig === lastSig) { return; }
    lastSig = sig;
    var keepScroll = box.scrollTop;

    if (!list.length) {
      box.innerHTML = '<div class="tm-empty">还没有闹钟。点下面「＋ 添加闹钟」。</div>';
    } else {
      box.innerHTML = list.map(function (a) {
        var w = nextAt(a, now);
        var sub = daysText(a) + (a.on && w ? ' · 下次 ' + relDay(w, now) : '');
        return '' +
          '<div class="al-item' + (a.on ? '' : ' off') + '" data-id="' + a.id + '">' +
            '<div class="al-main" data-edit="' + a.id + '">' +
              '<div class="al-time">' + pad(a.hh) + ':' + pad(a.mm) + '</div>' +
              '<div class="al-sub">' + esc(sub) + (a.label ? ' · ' + esc(a.label) : '') + '</div>' +
            '</div>' +
            '<div class="al-right">' +
              '<button class="al-switch' + (a.on ? ' on' : '') + '" data-toggle="' + a.id + '" ' +
                'title="' + (a.on ? '关闭' : '开启') + '"><i></i></button>' +
              '<button class="al-del" data-del="' + a.id + '" title="删除">×</button>' +
            '</div>' +
          '</div>';
      }).join('');
    }

    box.scrollTop = keepScroll;

    var note = $('#alNote');
    if (note) {
      var t = [];
      if (cfg.missedAt) {
        var d = new Date(cfg.missedAt);
        t.push('错过的闹钟：' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + (cfg.missedText || ''));
      }
      note.textContent = t.join('　');
      note.hidden = !t.length;
    }
    /* ⚠ 这里**不**重画编辑区。列表每秒都可能刷新，顺手重画编辑区的话，
       用户正在输入的时分会被重置回原值。编辑区只在进出编辑态时由
       paintEditor() 显式刷新。 */
  }

  function paintEditor() {
    var ed = $('#alEdit');
    if (!ed) { return; }
    var a = editingId ? find(editingId) : null;
    ed.classList.toggle('open', !!a || editingId === 'new');
    if (editingId === 'new') {
      a = { hh: 7, mm: 30, days: [], label: '', on: 1 };
    }
    if (!a) { return; }

    var th = $('#alTimeH'), tm = $('#alTimeM');
    if (th && document.activeElement !== th) { th.value = pad(a.hh); }
    if (tm && document.activeElement !== tm) { tm.value = pad(a.mm); }
    var lb = $('#alLabel');
    if (lb && document.activeElement !== lb) { lb.value = a.label || ''; }

    var days = a.days || [];
    var db = $('#alDays');
    if (db) {
      db.innerHTML = WEEK_ORDER.map(function (x) {
        var on = days.indexOf(x) >= 0;
        return '<button class="al-day' + (on ? ' on' : '') + '" data-day="' + x + '">' + DAY_CN[x] + '</button>';
      }).join('');
    }
    var quick = $('#alQuick');
    if (quick) {
      var presets = [
        ['单次', []], ['每天', [0, 1, 2, 3, 4, 5, 6]],
        ['工作日', [1, 2, 3, 4, 5]], ['周末', [0, 6]]
      ];
      quick.innerHTML = presets.map(function (p) {
        var on = p[1].length === days.length && p[1].every(function (x) { return days.indexOf(x) >= 0; });
        return '<button class="al-q' + (on ? ' on' : '') + '" data-quick="' +
          p[1].join(',') + '">' + p[0] + '</button>';
      }).join('');
    }
    var title = $('#alEditTitle');
    if (title) { title.textContent = editingId === 'new' ? '新建闹钟' : '编辑闹钟'; }
  }

  function editStart(id) {
    editingId = id || 'new';
    paintModal(true);
    paintEditor();
  }
  function editCancel() {
    editingId = null;
    paintEditor();
  }
  function editSave() {
    var th = $('#alTimeH'), tm = $('#alTimeM'), lb = $('#alLabel');
    var hh = Math.max(0, Math.min(23, parseInt(th && th.value, 10) || 0));
    var mm = Math.max(0, Math.min(59, parseInt(tm && tm.value, 10) || 0));
    var label = lb ? lb.value.trim().slice(0, 16) : '';
    var days = editingDays.slice();
    if (editingId === 'new') {
      add(hh, mm, days, label, 1);
    } else {
      update(editingId, { hh: hh, mm: mm, days: days, label: label, on: 1 });
    }
    editingId = null;
    paintModal(true);
    paintEditor();
  }

  var editingDays = [];
  function setEditingDays(days) {
    editingDays = (days || []).slice().sort();
    var a = editingId && editingId !== 'new' ? find(editingId) : null;
    if (a) { a.days = editingDays.slice(); }
    paintEditor();
  }
  function toggleEditingDay(x) {
    var i = editingDays.indexOf(x);
    if (i >= 0) { editingDays.splice(i, 1); } else { editingDays.push(x); }
    editingDays.sort();
    var a = editingId && editingId !== 'new' ? find(editingId) : null;
    if (a) { a.days = editingDays.slice(); }
    paintEditor();
  }
  function getEditingDays() { return editingDays.slice(); }
  function isEditing() { return !!editingId; }

  /* 进入编辑时把该闹钟的重复日同步进 editingDays */
  function syncEditingFromAlarm() {
    var a = editingId && editingId !== 'new' ? find(editingId) : null;
    editingDays = a ? (a.days || []).slice() : [];
  }
  var _editStart = editStart;
  editStart = function (id) { _editStart(id); syncEditingFromAlarm(); paintEditor(); };

  global.Alarms = {
    cfg: cfg,
    defaults: DEFAULT_CFG,
    setCfg: setCfg,
    saveCfg: saveCfg,
    list: function () { return list.slice(); },
    add: add,
    update: update,
    remove: remove,
    toggle: toggle,
    clearAll: clearAll,
    nextAt: nextAt,
    summary: summary,
    daysText: daysText,
    catchUp: catchUp,
    paint: paint,
    paintModal: paintModal,
    editStart: editStart,
    editCancel: editCancel,
    editSave: editSave,
    isEditing: isEditing,
    toggleEditingDay: toggleEditingDay,
    setEditingDays: setEditingDays,
    getEditingDays: getEditingDays,
    onChange: function (fn) { changeCbs.push(fn); },
    boot: start,
    shutdown: stop
  };
})(window);
