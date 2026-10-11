/* ============================================================================
 * app.js — 仪表板主逻辑（第一版）
 * 已实现：画布缩放、时钟（秒 / 12-24 制）、公历农历日期、月历（农历 / 节气 /
 *         节日 / 假期 / 今日高亮 / 翻月 / 日期详情与本地事件）、双主题切换、
 *         电量与存储（真实优先，失败降级模拟）、AI 问候语本地降级文案、
 *         对话抽屉（UI 就绪，接口待第五阶段接入）。
 * 待接入：天气 API（第二阶段）、背景（第三阶段）、温度桥接（第四阶段）、
 *         AI Chat Completions（第五阶段）、Kiosk / 常亮（第六阶段）。
 * ==========================================================================*/
(function () {
  'use strict';

  /* 把网页侧的报错递给 Android 壳，诊断页里能看到 */
  window.addEventListener('error', function (e) {
    try {
      if (window.Native && Native.available && Native.reportError) {
        Native.reportError((e && e.message ? e.message : '未知错误') +
          ' @' + (e && e.lineno ? e.lineno : '?') + ':' + (e && e.colno ? e.colno : '?'));
      }
    } catch (x) { }
  });

  /* ------------------------------------------------ 老引擎兼容（Chrome 74） */
  /**
   * flex 容器的 gap 要到 Chrome 84 才支持；不支持时它会被**整个忽略**，
   * 所有 flex 子元素紧挨在一起，排版全挤成一团。
   * 检测到就挂个 class，由 legacy.css 用 margin 把间距补回来。
   *
   * 顺带记一笔背景：iPlay 20 Pro 的系统 WebView 是 Chrome 74，
   * 而它自带的浏览器内核更新，所以"网页版能开、装进 APK 就白屏"。
   */
  function detectFlexGap() {
    try {
      var box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;position:absolute;' +
        'top:-9999px;left:-9999px;gap:4px;';
      var a = document.createElement('div');
      var b = document.createElement('div');
      a.style.cssText = 'width:4px;height:4px;';
      b.style.cssText = 'width:4px;height:4px;';
      box.appendChild(a);
      box.appendChild(b);
      document.body.appendChild(box);
      var gap = b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
      document.body.removeChild(box);
      return gap >= 1;
    } catch (e) {
      return true;   // 检测本身出错就当它支持，别把新浏览器也拖下水
    }
  }

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };

  var LS = {
    get: function (k, d) {
      try { var v = localStorage.getItem('dash.' + k); return v === null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem('dash.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ------------------------------------------------------------------ 状态 */
  var state = {
    theme: LS.get('theme', 'light'),
    hour12: LS.get('hour12', 0) ? 1 : 0,
    showSeconds: LS.get('showSeconds', 1) ? 1 : 0,
    wakeLock: 0,
    view: { y: 0, m: 0 },
    sim: { battery: false, storage: false, net: false },
    battery: { level: 0.82, charging: true },
    storage: 64,
    online: true,
    events: LS.get('events', {}),
    /* 天气数据：init 里先用缓存 / 内置兜底渲染，再异步拉真实数据 */
    weather: null,
    /* 外观与定时（第六阶段·网页部分） */
    manualTheme: LS.get('theme', 'light'),
    themeMode: LS.get('themeMode', 'manual'),      /* manual | time | system */
    nightQuiet: LS.get('nightQuiet', 0) ? 1 : 0,
    nqDim: LS.get('nqDim', 25),
    burnShift: LS.get('burnShift', 0) ? 1 : 0,
    burnMode: LS.get('burnMode', 'step'),          /* step | drift | jitter */
    burnAmp: LS.get('burnAmp', 4),                 /* 2–12 px */
    burnMinutes: LS.get('burnMinutes', 5),         /* 换位间隔（分钟） */
    exportFull: LS.get('exportFull', 0) ? 1 : 0
  };

  var GREET = {
    '凌晨': [['凌晨好', '该睡了，别熬着。'], ['夜深了', '屏幕还亮着，人也该歇了。']],
    '上午': [['上午好', '今天也慢慢来。'], ['早上好', '先喝口水再忙。']],
    '中午': [['中午好', '记得吃饭。'], ['正午了', '别只顾着做事。']],
    '下午': [['下午好', '今天也好好放松吧。'], ['下午好', '光线正好，别太累。'], ['下午好', '泡杯茶，歇一会儿。']],
    '晚上': [['晚上好', '今天辛苦了。'], ['晚上了', '早点收工吧。']]
  };

  /* -------------------------------------------------------------- 画布缩放 */
  /**
   * 把 1920×1200 的设计稿等比缩放着放进视口。
   *
   * ⚠ 这里踩过一个能把整页变白的坑：
   *   WebView 里首帧可能还没完成布局，此时 window.innerWidth / innerHeight 是 0，
   *   算出来的 scale 就是 0 —— #stage 被缩成看不见，屏幕上只剩 body 底色，
   *   表现就是"打开一片白，什么都没有"。
   *   所以尺寸不可信时**直接返回失败、不写 transform**，交给重试逻辑慢慢等。
   */
  /**
   * 设计单位 --u（改造后）：
   *
   * 布局本身已经全部交给 CSS —— #stage 铺满视口，尺寸写成 calc(N * var(--u))，
   * 而 base.css 里给了 --u 一个纯 CSS 的默认值（vw/vh + @media min-aspect-ratio，
   * 语义等价于 min(vw/1920, vh/1200)）。所以**没有 JS 也不会错**。
   *
   * 这里只是把 --u 再用实测视口精修一遍：移动端浏览器 vh 有时指的是"大视口"
   * （地址栏收起后的高度），会比真实可视高度大一点，用 clientWidth/Height
   * 覆盖掉更准。
   *
   * 顺带说：老的 transform: scale() 方案有个能把整页缩成看不见的坑
   * （首帧 innerWidth/Height 为 0 → scale 算成 0），现在连土壤都没有了。
   */
  function fitStage() {
    var de = document.documentElement;
    var w = de.clientWidth || window.innerWidth || 0;
    var h = de.clientHeight || window.innerHeight || 0;
    if (w < 2 || h < 2) { return false; }

    var u = Math.min(w / 1920, h / 1200);
    if (!isFinite(u) || u <= 0) { return false; }

    de.style.setProperty('--u', u + 'px');
    return true;
  }

  /** 首帧拿不到尺寸就一直重试；CSS 兜底值会一直顶着，所以失败也不会白屏 */
  function fitStageRetry() {
    if (fitStage()) { return; }
    var tries = 0;
    (function loop() {
      if (fitStage()) { return; }
      if (++tries > 40) { return; }   /* 交给 base.css 里的 --u 默认值 */
      setTimeout(loop, 100);
    })();
  }

  /* ------------------------------------------------------------------ 时钟 */
  function periodOf(h) {
    return h < 5 ? '凌晨' : h < 11 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
  }

  function renderClock() {
    var d = new Date();
    var h = d.getHours(), mi = d.getMinutes(), s = d.getSeconds();
    var ap = '';
    if (state.hour12) { ap = h < 12 ? '上午' : '下午'; h = h % 12 || 12; }
    $('#tHm').textContent = pad(h) + ':' + pad(mi);
    var tS = $('#tS');
    tS.textContent = ':' + pad(s);
    tS.style.display = state.showSeconds ? '' : 'none';
    $('#tAp').textContent = ap;
  }

  function renderDate() {
    var d = new Date();
    var info = Lunar.dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate(), d);
    $('#mWeek').textContent = info.weekCn;
    $('#mWeekEn').textContent = info.weekEn;
    $('#mDate').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    $('#mLunar').textContent = info.lunar.full;
  }

  /* ------------------------------------------------------------------ 月历 */
  function renderCalendar() {
    var y = state.view.y, m = state.view.m;
    var today = new Date();
    $('#calTitle').textContent = y + '年' + m + '月';

    var first = new Date(y, m - 1, 1);
    var lead = (first.getDay() + 6) % 7;                 /* 周一为起始 */
    var start = new Date(y, m - 1, 1 - lead);

    var grid = $('#calGrid');
    grid.innerHTML = '';
    var frag = document.createDocumentFragment();

    for (var i = 0; i < 42; i++) {
      var day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var dy = day.getFullYear(), dm = day.getMonth() + 1, dd = day.getDate();
      var info = Lunar.dayInfo(dy, dm, dd, today);
      var key = dy + '-' + dm + '-' + dd;

      var cell = document.createElement('div');
      cell.className = 'cal-cell';
      if (dm !== m) { cell.className += ' other-month'; }
      if (info.isToday) { cell.className += ' today'; }
      if (info.holiday && info.holiday.type === 'off') { cell.className += ' holiday'; }
      if (info.holiday && info.holiday.type === 'work') { cell.className += ' workday'; }

      var html = '';
      if (info.holiday && info.holiday.type === 'off') { html += '<span class="c-dot"></span>'; }
      html += '<span class="c-num">' + dd + '</span>';
      html += '<span class="c-ul"></span>';
      var subCls = (info.holiday && info.holiday.type === 'work') ? 'workday' : info.subType;
      var subTxt = (info.holiday && info.holiday.type === 'work') ? '班' : info.subText;
      html += '<span class="c-sub ' + subCls + '">' + subTxt + '</span>';
      if (state.events[key] && state.events[key].length) { html += '<span class="c-ev"></span>'; }
      cell.innerHTML = html;

      cell.setAttribute('data-date', key);
      frag.appendChild(cell);
    }
    grid.appendChild(frag);

    var hol = Lunar.currentHoliday(today);
    var label = hol ? hol.label : '';
    $$('[data-holiday-label]').forEach(function (el) { el.textContent = label; });
    $('#calHoliday').textContent = label;
  }

  /* ------------------------------------------------------------------ 天气 */
  /* 线性天气图标（与两套主题的极简线条气质一致，跟随 currentColor 上色） */
  var ICO_RAYS = '<line x1="24" y1="2.6" x2="24" y2="9.4"/><line x1="24" y1="38.6" x2="24" y2="45.4"/>' +
    '<line x1="2.6" y1="24" x2="9.4" y2="24"/><line x1="38.6" y1="24" x2="45.4" y2="24"/>' +
    '<line x1="8.9" y1="8.9" x2="13.7" y2="13.7"/><line x1="34.3" y1="34.3" x2="39.1" y2="39.1"/>' +
    '<line x1="39.1" y1="8.9" x2="34.3" y2="13.7"/><line x1="13.7" y1="34.3" x2="8.9" y2="39.1"/>';
  var ICO_CLOUD = '<path d="M16 34h16.5a6.2 6.2 0 0 0 .5-12.3 9.2 9.2 0 0 0-17.4-1.9A6.8 6.8 0 0 0 16 34z"/>';
  var ICO_CLOUD_S = '<path d="M20 37h14.5a5.7 5.7 0 0 0 .4-11.3 8.5 8.5 0 0 0-16-1.7A6.3 6.3 0 0 0 20 37z"/>';

  var ICONS = {
    'sun': '<circle cx="24" cy="24" r="8.6"/>' + ICO_RAYS,
    'sun-cloud': '<circle cx="17.5" cy="16.5" r="6"/>' +
      '<line x1="17.5" y1="4.5" x2="17.5" y2="8.2"/><line x1="5.5" y1="16.5" x2="9.2" y2="16.5"/>' +
      '<line x1="9.1" y1="8.1" x2="11.7" y2="10.7"/><line x1="25.9" y1="8.1" x2="23.3" y2="10.7"/>' +
      ICO_CLOUD_S,
    'cloud': ICO_CLOUD,
    'rain': ICO_CLOUD +
      '<line x1="17" y1="38" x2="15" y2="44"/><line x1="24" y1="38" x2="22" y2="44"/>' +
      '<line x1="31" y1="38" x2="29" y2="44"/>',
    'snow': ICO_CLOUD +
      '<circle cx="16.5" cy="41" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="24" cy="41" r="1.6" fill="currentColor" stroke="none"/>' +
      '<circle cx="31.5" cy="41" r="1.6" fill="currentColor" stroke="none"/>',
    'fog': '<line x1="9" y1="18" x2="39" y2="18"/><line x1="6" y1="25" x2="42" y2="25"/>' +
      '<line x1="11" y1="32" x2="37" y2="32"/><line x1="15" y1="39" x2="33" y2="39"/>',
    'thunder': ICO_CLOUD + '<path d="M26 35l-7 8h5l-2.5 6L29 40h-5z"/>'
  };

  function renderWeather() {
    var w = state.weather;
    if (!w) { return; }
    var F = Weather.cfg.fields;

    $('#wCity').textContent = w.city || '--';
    $('#wCondText').textContent = w.cond || '--';
    $('#wTemp').textContent = (w.temp == null ? '--' : w.temp);
    var ico = $('#wIcon');
    if (ico) { ico.innerHTML = ICONS[w.icon] || ICONS.sun; }

    /* 今日最高 / 最低 */
    $('#wHiLo').innerHTML = (!F.hiLo || w.hi == null) ? '' :
      '<span class="k">最高</span> <span class="v">' + w.hi + '°</span>' +
      '<span class="sep">·</span>' +
      '<span class="k">最低</span> <span class="v">' + w.lo + '°</span>';

    /* 日出 / 日落：浅色主题放天气栏，深色主题放左栏「天象」块 */
    var sunHtml = (!F.sun) ? '' :
      '<span class="sun-cell"><span class="sun-k">日出</span><span class="sun-v">' + w.sunrise + '</span></span>' +
      '<span class="sun-cell"><span class="sun-k">日落</span><span class="sun-v">' + w.sunset + '</span></span>';
    $('#wSun').innerHTML = sunHtml;
    $('#clkSun').innerHTML = sunHtml;

    /* 浅色：紧凑小字，指标两两一行 */
    var chips = [];
    if (F.humidity) { chips.push('湿度' + w.humidity + '%'); }
    if (F.wind) { chips.push((w.windDir ? w.windDir + ' ' : '') + w.windScale); }
    if (F.aqi) { chips.push('空气' + (w.aqiText || '--')); }
    if (F.uv) { chips.push('紫外线' + (w.uvText || '--')); }
    var linesHtml = '<div class="line-1">' + (w.cond || '--') +
      (F.feels && w.feels != null ? ' <span class="k">体感' + w.feels + '°</span>' : '') + '</div>';
    for (var ci = 0; ci < chips.length; ci += 2) {
      linesHtml += '<div class="k">' + chips.slice(ci, ci + 2).map(function (c) {
        return '<span>' + c + '</span>';
      }).join('') + '</div>';
    }
    $('#wLines').innerHTML = linesHtml;

    /* 浅色：预报文本，每天高 / 低温，一行最多三个 */
    var fc = (!F.forecast || !(w.forecast || []).length) ? [] :
      w.forecast.slice(0, Weather.cfg.days >= 7 ? 7 : 3);
    var fRows = '';
    for (var fi = 0; fi < fc.length; fi += 3) {
      fRows += '<div>' + fc.slice(fi, fi + 3).map(function (f) {
        return '<span>' + f.w + f.hi + '°/' + f.lo + '°</span>';
      }).join('') + '</div>';
    }
    $('#wForecast').innerHTML = fRows;

    /* 深色：未来五天高低温微型折线图（琥珀实线=最高，灰虚线=最低） */
    var f = (!F.forecast || !(w.forecast || []).length) ? [] : w.forecast.slice(0, 5);
    if (!f.length) {
      $('#wChart').innerHTML = '';
    } else {
    var W = 520, H = 226, L = 30, R = 30, T = 44, B = 158;
    var top = Math.max.apply(null, f.map(function (x) { return x.hi; })) + 2;
    var bot = Math.min.apply(null, f.map(function (x) { return x.lo; })) - 2;
    var step = f.length > 1 ? (W - L - R) / (f.length - 1) : 0;
    var yOf = function (t) { return B - (t - bot) / (top - bot) * (B - T); };
    var hp = f.map(function (x, i) { return { x: L + i * step, y: yOf(x.hi), t: x.hi, w: x.w }; });
    var lp = f.map(function (x, i) { return { x: L + i * step, y: yOf(x.lo), t: x.lo, w: x.w }; });
    var hLine = hp.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
    var lLine = lp.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
    var area = 'M' + hp[0].x.toFixed(1) + ',' + B + ' L' + hLine.split(' ').join(' L') +
      ' L' + hp[hp.length - 1].x.toFixed(1) + ',' + B + ' Z';

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" fill="none">' +
      '<defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#F0A52B" stop-opacity=".18"/>' +
      '<stop offset="100%" stop-color="#F0A52B" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#wg)"/>' +
      '<polyline points="' + lLine + '" stroke="#5A6169" stroke-width="1.4" ' +
      'stroke-dasharray="3 4" stroke-linejoin="round"/>' +
      '<polyline points="' + hLine + '" stroke="#F0A52B" stroke-width="1.8" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>';
    hp.forEach(function (p) {
      svg += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="3" fill="#F0A52B"/>' +
        '<text x="' + p.x.toFixed(1) + '" y="' + (p.y - 13).toFixed(1) +
        '" fill="#E8EAED" font-size="17" text-anchor="middle">' + p.t + '°</text>';
    });
    lp.forEach(function (p) {
      svg += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2.4" fill="#6B7076"/>' +
        '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + 21).toFixed(1) +
        '" fill="#9AA0A6" font-size="15" text-anchor="middle">' + p.t + '°</text>' +
        '<text x="' + p.x.toFixed(1) + '" y="210" fill="#9AA0A6" font-size="16" ' +
        'text-anchor="middle">' + p.w + '</text>';
    });
    svg += '</svg>';
    $('#wChart').innerHTML = svg;
    }

    /* 深色：指标行，按设置里勾选的字段渲染 */
    var metrics = [];
    if (F.humidity) { metrics.push({ k: '湿度', v: w.humidity + '%', p: w.humidityPct || 0 }); }
    if (F.wind) { metrics.push({ k: '风力', v: w.windScale || '--', p: w.windPct || 0 }); }
    if (F.aqi) { metrics.push({ k: '空气', v: w.aqiText || '--', p: w.aqi == null ? 4 : w.aqiPct }); }
    if (F.uv) { metrics.push({ k: '紫外线', v: w.uvText || '--', p: w.uv == null ? 4 : w.uvPct }); }
    $('#wMetrics').innerHTML = metrics.map(function (x) {
      return '<div class="metric"><span class="k">' + x.k + '</span>' +
        '<span class="bar"><i style="width:' + x.p + '%"></i></span>' +
        '<span class="v">' + x.v + '</span></div>';
    }).join('');

    renderWeatherMeta();
  }

  /* 天气来源 / 缓存时间标注
   * 只有"真的没拉到新数据"才提示：
   *   · 缓存没过期 → 正常路径，不提示
   *   · 请求失败回退缓存 → 提示并标出缓存时间与失败原因 */
  function renderWeatherMeta() {
    var el = $('#wMeta');
    if (!el) { return; }
    var w = state.weather;
    var mustWarn = w && (w.error || (w.fromCache && w.fresh === false));
    if (!mustWarn) { el.textContent = ''; el.classList.remove('warn'); return; }
    var t = w.updatedAt ? new Date(w.updatedAt) : null;
    var hm = t ? (pad(t.getHours()) + ':' + pad(t.getMinutes())) : '--:--';
    var days = t ? Math.floor((Date.now() - t.getTime()) / 86400000) : 0;
    el.textContent = '缓存数据 · 更新于 ' + hm + (days > 0 ? '（' + days + ' 天前）' : '') +
      (w.error ? ' · ' + w.error : '');
    el.classList.add('warn');
  }

  /* ------------------------------------------------- 天气刷新与定时调度 */
  var wxTimer = null;

  function refreshWeather(force) {
    return Weather.refresh({ force: !!force }).then(function (w) {
      state.weather = w;
      renderWeather();
      renderGreeting(false);   /* 只更新问候语里的天气上下文，不重新抽句子 */
      syncSettings();
      scheduleWeather();
      return w;
    });
  }

  function scheduleWeather() {
    if (wxTimer) { clearTimeout(wxTimer); }
    var h = Math.max(1, Weather.cfg.refreshHours || 2);
    wxTimer = setTimeout(function () { refreshWeather(true); }, h * 3600 * 1000);
  }

  /* --------------------------------------------- 背景设置面板（第三阶段） */
  function renderBgList() {
    var box = $('#bgList');
    if (!box) { return; }
    var list = Background.list();
    box.innerHTML = '';
    list.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'bg-item';
      row.setAttribute('data-id', m.id);

      var th = document.createElement('div');
      th.className = 'bg-thumb';
      /* 缩略图现在是异步的（图片存在 IndexedDB 里）。
         内存里已经有的先直接贴上，避免列表刷新时闪一下空白。 */
      var tb0 = Background.peekThumb(m.id);
      if (tb0) {
        th.style.backgroundImage = 'url("' + tb0 + '")';
      } else {
        Background.getThumb(m.id).then(function (tb) {
          if (tb) { th.style.backgroundImage = 'url("' + tb + '")'; }
        });
      }

      var info = document.createElement('div');
      info.className = 'bg-info';
      var nm = document.createElement('div');
      nm.className = 'bg-name';
      nm.textContent = m.name;
      var sub = document.createElement('div');
      sub.className = 'bg-sub';
      sub.textContent = (m.w && m.h ? (m.w + '×' + m.h + ' · ') : '') +
        Math.round((m.bytes || 0) / 1024) + ' KB';
      info.appendChild(nm);
      info.appendChild(sub);

      var seg = document.createElement('div');
      seg.className = 'seg seg-slot';
      [['all', '全天'], ['day', '白天'], ['night', '夜间']].forEach(function (s) {
        var b = document.createElement('button');
        b.setAttribute('data-slot', s[0]);
        b.textContent = s[1];
        if ((m.slot || 'all') === s[0]) { b.className = 'on'; }
        seg.appendChild(b);
      });

      var del = document.createElement('button');
      del.className = 'bg-del';
      del.setAttribute('data-del', m.id);
      del.textContent = '×';
      del.title = '删除这张';

      row.appendChild(th);
      row.appendChild(info);
      row.appendChild(seg);
      row.appendChild(del);
      box.appendChild(row);
    });
    renderBgNote();
  }

  function renderBgNote() {
    var el = $('[data-bg-note]');
    if (!el || !window.Background) { return; }
    var used = Background.usedBytes(), cap = Background.softCap();
    var slot = Background.currentSlot() === 'day' ? '白天' : '夜间';
    var st = Background.storeState();
    var mode = st === 'idb' ? 'IndexedDB' : (st === 'ls' ? 'localStorage（降级，容量小）' : '检测中…');
    var cap2 = Background.targetLongEdge();
    el.textContent = '已存 ' + Background.list().length + ' 张，占用 ' +
      (used / 1048576).toFixed(2) + ' MB / 约 ' + (cap / 1048576).toFixed(1) +
      ' MB（' + mode + '）；当前时段（' + slot + '）可用 ' + Background.candidates().length +
      ' 张；导入长边上限 ' + cap2 + ' px。';
  }

  function syncBgSettings() {
    if (!window.Background) { return; }
    var C = Background.cfg;
    $$('[data-seg="bgMode"] button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-val') === C.mode);
    });
    $$('[data-seg="bgInterval"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === +C.intervalSec);
    });
    $$('[data-seg="bgFrosted"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === (C.frosted ? 1 : 0));
    });
    $$('[data-seg="bgRes"] button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-val') === (C.res || 'auto'));
    });
    [['#bgBlur', C.blur], ['#bgVeilLight', C.veilLight], ['#bgVeilDark', C.veilDark]].forEach(function (p) {
      var el = $(p[0]);
      if (el && document.activeElement !== el) { el.value = p[1]; }
    });
    var set = function (sel, v) { var el = $(sel); if (el) { el.textContent = v; } };
    set('[data-bg-blur]', C.blur);
    set('[data-bg-vl]', C.veilLight);
    set('[data-bg-vd]', C.veilDark);
    [['#bgDay', C.dayStart], ['#bgNight', C.nightStart]].forEach(function (p) {
      var el = $(p[0]);
      if (el && document.activeElement !== el) { el.value = p[1]; }
    });
    renderBgNote();
  }

  function bindBgUI() {
    var fileEl = $('#bgFile');

    $('#bgPick').addEventListener('click', function () { fileEl.click(); });

    fileEl.addEventListener('change', function () {
      var files = this.files;
      if (!files || !files.length) { return; }
      var note = $('[data-bg-note]');
      note.textContent = '正在压缩处理 ' + files.length + ' 张图片…';
      Background.addFiles(files).then(function (r) {
        fileEl.value = '';
        renderBgList();
        syncBgSettings();
        var msg = '已导入 ' + r.added.length + ' 张';
        if (r.failed.length) {
          msg += '；' + r.failed.length + ' 张失败 —— ' + r.failed.map(function (f) {
            return f.name + '（' + f.why + '）';
          }).join('，');
        }
        note.textContent = msg + '。';
      }).catch(function (e) {
        fileEl.value = '';
        note.textContent = '导入失败：' + ((e && e.message) || e);
      });
    });

    $('#bgList').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        Background.removeItem(del.getAttribute('data-del')).then(function () {
          renderBgList(); syncBgSettings();
        });
        return;
      }
      var sl = e.target.closest('[data-slot]');
      if (sl) {
        var row = sl.closest('.bg-item');
        Background.setSlot(row.getAttribute('data-id'), sl.getAttribute('data-slot')).then(function () {
          renderBgList(); syncBgSettings();
        });
      }
    });

    [['#bgBlur', 'blur'], ['#bgVeilLight', 'veilLight'], ['#bgVeilDark', 'veilDark']].forEach(function (p) {
      $(p[0]).addEventListener('input', function () {
        var patch = {};
        patch[p[1]] = +this.value;
        Background.setCfg(patch);
        Background.applyStyle();
        syncBgSettings();
      });
    });

    $('#bgDay').addEventListener('change', onTimeChange);
    $('#bgNight').addEventListener('change', onTimeChange);

    function onTimeChange() {
      Background.setCfg({ dayStart: $('#bgDay').value || '06:00', nightStart: $('#bgNight').value || '18:00' });
      Background.refresh(true);
      Background.schedule();
      syncBgSettings();
    }

    $('#bgClear').addEventListener('click', function () {
      if (!Background.list().length) { return; }
      if (!window.confirm('清空全部背景图片？此操作不可撤销。')) { return; }
      Background.clearAll().then(function () {
        renderBgList();
        syncBgSettings();
      });
    });
  }

  /* ------------------------------------------- AI 设置回填与交互（第五阶段） */
  function setAiNote(t) {
    var el = $('[data-ai-note]');
    if (el) { el.textContent = t; }
  }

  /** 交给 ai.js 的实时上下文：时间、农历、节气、假期、天气、电量、网络 */
  function buildAiContext() {
    var d = new Date();
    var info = Lunar.dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate(), d);
    var hol = Lunar.currentHoliday(d);
    var w = state.weather || {};
    var fc = (w.forecast || []).slice(0, 3).map(function (f) {
      return f.w + ' ' + f.hi + '/' + f.lo + '°';
    }).join('，');
    var pct = Math.round((state.battery.level || 0) * 100);
    return {
      time: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
      period: periodOf(d.getHours()),
      date: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日',
      week: info.weekCn,
      lunar: info.lunar.full,
      term: info.term || '',
      festival: info.festival || '',
      holiday: hol ? (hol.label + '，第 ' + (hol.total - hol.daysLeft + 1) + ' 天，还剩 ' + hol.daysLeft + ' 天') : '',
      weather: w,
      forecast: fc,
      battery: pct + '%' + (state.battery.charging ? '（充电中）' : ''),
      net: state.online ? '已连接' : '离线'
    };
  }

  /* ------------------------------------------------------------ 人设 UI */
  function syncPersonaUI() {
    if (!window.AI) { return; }
    var C = AI.cfg;
    segSet('personaOn', C.personaOn);

    var list = AI.personas();
    var cur = AI.personaById(C.personaId);
    var box = $('#personaList');
    if (box) {
      box.innerHTML = list.length
        ? list.map(function (p) {
            return '<button class="persona-chip' + (p.id === C.personaId ? ' on' : '') +
              '" data-persona="' + p.id + '" type="button">' +
              escapeHtml(p.name) +
              (p.builtin ? '<span class="pc-tag">内置</span>' : '') +
            '</button>';
          }).join('')
        : '<span class="persona-empty">还没有人设。在下面写一段，再点「另存为新人设」。</span>';
    }

    var ta = $('#personaText');
    if (ta) {
      if (document.activeElement !== ta) { ta.value = cur ? cur.prompt : ''; }
      ta.disabled = !cur;
    }

    var note = $('[data-persona-note]');
    if (note) {
      if (!list.length) {
        note.textContent = '人设是一段可复用的语气设定，会追加在问候语 / 对话提示词之后。';
      } else if (!C.personaOn) {
        note.textContent = '人设当前是关闭的 —— 上面选中的那个只用于编辑，不会生效。';
      } else if (!cur) {
        note.textContent = '⚠ 已经打开人设，但还没选具体哪一个，等于没生效。';
      } else {
        note.textContent = '正在使用「' + cur.name + '」，它的内容会追加在两段提示词之后。';
      }
    }
  }

  function bindPersonaUI() {
    var box = $('#personaList');
    if (box) {
      box.addEventListener('click', function (e) {
        var chip = e.target.closest('[data-persona]');
        if (!chip) { return; }
        var id = chip.getAttribute('data-persona');
        /* 选人设 = 选中 + 自动打开，不然点了半天没反应会让人困惑 */
        AI.setCfg({ personaId: id, personaOn: 1 });
        syncAiSettings();
      });
    }

    var ta = $('#personaText');
    if (ta) {
      ta.addEventListener('input', function () {
        if (!AI.cfg.personaId) { return; }
        AI.updatePersona(AI.cfg.personaId, { prompt: this.value });
        var note = $('[data-persona-note]');
        if (note) { note.textContent = '已保存到「' + (AI.personaById(AI.cfg.personaId) || {}).name + '」。'; }
      });
    }

    if ($('#personaSaveAs')) {
      $('#personaSaveAs').addEventListener('click', function () {
        var nameEl = $('#personaName');
        var name = nameEl ? nameEl.value.trim() : '';
        var text = ta ? ta.value.trim() : '';
        if (!text) {
          var note = $('[data-persona-note]');
          if (note) { note.textContent = '人设内容是空的，先写点什么再存。'; }
          return;
        }
        var id = AI.addPersona(name || ('人设 ' + (AI.personas().length + 1)), text);
        AI.setCfg({ personaId: id, personaOn: 1 });
        if (nameEl) { nameEl.value = ''; }
        syncAiSettings();
      });
    }

    if ($('#personaDelete')) {
      $('#personaDelete').addEventListener('click', function () {
        var cur = AI.personaById(AI.cfg.personaId);
        if (!cur) { return; }
        if (!window.confirm('删除人设「' + cur.name + '」？删掉之后不会再自动回来。')) { return; }
        AI.removePersona(cur.id);
        syncAiSettings();
      });
    }
  }

  function syncAiSettings() {
    if (!window.AI) { return; }
    var C = AI.cfg;
    var segOn = function (name, on) {
      $$('[data-seg="' + name + '"] button').forEach(function (b) {
        b.classList.toggle('on', +b.getAttribute('data-val') === (on ? 1 : 0));
      });
    };
    segOn('aiEnabled', C.enabled);
    segOn('aiStream', C.stream);
    segOn('exportFull', state.exportFull);
    $$('[data-seg="aiMode"] button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-val') === C.greetMode);
    });

    [['#aiBase', C.baseUrl], ['#aiModel', C.model], ['#aiKey', C.key]].forEach(function (p) {
      var el = $(p[0]);
      if (el && document.activeElement !== el) { el.value = p[1] || ''; }
    });
    [['#aiHours', C.greetHours], ['#aiMax', C.maxTokens], ['#aiHist', C.historyLimit]].forEach(function (p) {
      var el = $(p[0]);
      if (el && document.activeElement !== el) { el.value = p[1]; }
    });
    var tp = $('#aiPrompt');
    if (tp && document.activeElement !== tp) { tp.value = C.prompt || ''; }
    var tcp = $('#aiChatPrompt');
    if (tcp && document.activeElement !== tcp) { tcp.value = C.chatPrompt || ''; }
    syncPersonaUI();
    var tm = $('#aiTemp');
    if (tm && document.activeElement !== tm) { tm.value = C.temperature; }
    var tl = $('[data-ai-temp]');
    if (tl) { tl.textContent = (+C.temperature).toFixed(1); }

    var g = AI.getGreeting();
    setAiNote(C.enabled
      ? (g && g.at
        ? 'AI 已启用 · 上次生成 ' + new Date(g.at).toLocaleString().slice(5, 16) + '，当前显示这条缓存。'
        : 'AI 已启用 · 还没成功生成过，暂时显示内置问候语。')
      : 'AI 未启用，当前使用内置问候语。');

    var pn = $('[data-preset-note]');
    if (pn) {
      if (AI.hasPreset) {
        pn.hidden = false;
        pn.textContent = '★ 这个版本内置了一组可直接使用的 API（' + (AI.preset.model || AI.cfg.model) +
          '），不用配置就能用；也可以换成你自己的地址与 Key（把地址清空会自动恢复内置）。';
      } else {
        pn.hidden = true;
      }
    }
  }

  function bindAppearanceUI() {
    var d = $('#nqDim');
    if (d) {
      d.addEventListener('input', function () {
        state.nqDim = +this.value;
        LS.set('nqDim', state.nqDim);
        applyAuto();
        syncAppearanceSettings();
      });
    }
    var ba = $('#burnAmp');
    if (ba) {
      ba.addEventListener('input', function () {
        state.burnAmp = +this.value;
        LS.set('burnAmp', state.burnAmp);
        applyBurn();
        syncAppearanceSettings();
      });
    }
    var bp = $('#burnPreview');
    if (bp) { bp.addEventListener('click', burnStep); }
    if (mqDark && mqDark.addEventListener) {
      mqDark.addEventListener('change', function () { applyAuto(); });
    }
  }

  function bindAiUI() {
    var bindText = function (sel, key, transform) {
      var el = $(sel);
      if (!el) { return; }
      el.addEventListener('change', function () {
        var patch = {};
        patch[key] = transform ? transform(this.value) : this.value;
        AI.setCfg(patch);
        syncAiSettings();
      });
    };
    bindText('#aiBase', 'baseUrl', function (v) { return String(v).trim(); });
    bindText('#aiKey', 'key', function (v) { return String(v).trim(); });
    bindText('#aiModel', 'model', function (v) { return String(v).trim(); });
    bindText('#aiHours', 'greetHours', function (v) { return Math.max(1, Math.min(24, +v || 6)); });
    bindText('#aiMax', 'maxTokens', function (v) { return Math.max(32, Math.min(4096, +v || 220)); });
    bindText('#aiHist', 'historyLimit', function (v) { return Math.max(2, Math.min(40, +v || 12)); });
    bindText('#aiPrompt', 'prompt');
    bindText('#aiChatPrompt', 'chatPrompt');
    bindPersonaUI();

    var tm = $('#aiTemp');
    if (tm) {
      tm.addEventListener('input', function () {
        AI.setCfg({ temperature: +this.value });
        var l = $('[data-ai-temp]');
        if (l) { l.textContent = (+this.value).toFixed(1); }
      });
    }
    $('#aiPromptReset').addEventListener('click', function () {
      AI.setCfg({ prompt: AI.defaultPrompt });
      syncAiSettings();
      setAiNote('已恢复默认问候语提示词。');
    });
    if ($('#aiChatPromptReset')) {
      $('#aiChatPromptReset').addEventListener('click', function () {
        AI.setCfg({ chatPrompt: AI.defaultChatPrompt });
        syncAiSettings();
        setAiNote('已恢复默认对话提示词。');
      });
    }
    $('#aiTest').addEventListener('click', function () {
      setAiNote('正在测试连接…');
      AI.test().then(function (r) {
        setAiNote((r.ok ? '✓ 连接正常（' + r.ms + ' ms）：' : '✗ 连接失败（' + r.ms + ' ms）：') + r.msg);
      });
    });
    $('#aiRegen').addEventListener('click', function () {
      setAiNote('正在生成问候语…');
      refreshGreeting(true).then(function () { setAiNote('问候语已更新。'); });
    });
    $('#aiClearChat').addEventListener('click', function () {
      AI.clearHistory(); renderChat(); setAiNote('对话已清空。');
    });
    $('#chatClear').addEventListener('click', function () {
      AI.clearHistory(); renderChat();
    });
  }

  /* --------------------------------------------------- 配置导出 / 导入 */
  function copyObj(o) {
    var r = {};
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { r[k] = o[k]; } }
    return r;
  }

  function doExport() {
    var full = !!state.exportFull;
    var note = $('[data-cfg-note]');
    var data = {
      _app: '平板仪表板', _version: 4, _exportedAt: new Date().toISOString(),
      ui: {
        theme: state.manualTheme, themeMode: state.themeMode,
        hour12: state.hour12, showSeconds: state.showSeconds, wakeLock: state.wakeLock,
        nightQuiet: state.nightQuiet, nqDim: state.nqDim, burnShift: state.burnShift
      },
      weather: copyObj(Weather.cfg),
      background: copyObj(Background.cfg),
      ai: copyObj(AI.cfg),
      events: state.events,
      /* 计时器 / 闹钟 / 提醒（自定义音频文件本身不入配置，太大了） */
      timers: {
        cfg: copyObj(Timers.cfg),
        list: Timers.list(),
        presets: Timers.presets()
      },
      alarms: {
        cfg: copyObj(Alarms.cfg),
        list: Alarms.list()
      },
      remind: copyObj(Remind.cfg)
    };
    if (!full) { delete data.weather.key; delete data.ai.key; }

    function save() {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '仪表板配置-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
      if (note) {
        note.textContent = '已导出' + (full ? '（含 API Key 与背景图，分享前想清楚）' : '（不含 Key 与背景图）') + '。';
      }
    }

    if (!full) { save(); return; }

    /* 背景图现在存在 IndexedDB 里，取图是异步的 —— 先把全部读出来再打包 */
    if (note) { note.textContent = '正在打包背景图…'; }
    Promise.all(Background.list().map(function (m) {
      return Background.getData(m.id).then(function (d) {
        return {
          id: m.id, name: m.name, slot: m.slot, w: m.w, h: m.h, bytes: m.bytes,
          data: d
        };
      });
    })).then(function (arr) {
      data.backgroundImages = arr;
      save();
    }).catch(function (e) {
      if (note) { note.textContent = '导出失败：' + ((e && e.message) || e); }
    });
  }

  /** 把导出的背景图写回去（走 Background 的统一存储口），并重新生成缩略图 */
  function restoreImages(list) {
    return new Promise(function (resolve) {
      var i = 0, out = [];
      function next() {
        if (i >= list.length) { resolve(out); return; }
        var it = list[i++];
        if (!it || !it.data) { next(); return; }
        var img = new Image();
        img.onload = function () {
          var tw = 220;
          var th = Math.max(1, Math.round(tw * img.naturalHeight / img.naturalWidth));
          var c = document.createElement('canvas');
          c.width = tw; c.height = th;
          var g = c.getContext('2d');
          g.fillStyle = '#ffffff'; g.fillRect(0, 0, tw, th);
          g.drawImage(img, 0, 0, tw, th);
          var thumb = '';
          try { thumb = c.toDataURL('image/jpeg', 0.7); } catch (e) {}
          Background.putImage(it.id, it.data, thumb).then(function () {
            out.push({
              id: it.id, name: it.name || '背景', slot: it.slot || 'all',
              w: it.w || tw, h: it.h || th,
              bytes: it.bytes || String(it.data).length, addedAt: Date.now()
            });
            next();
          }).catch(function () {
            /* 写不进去（空间不足等）就跳过这张，别让整次导入卡死 */
            next();
          });
        };
        img.onerror = function () { next(); };
        img.src = it.data;
      }
      next();
    });
  }

  function doImport(text) {
    var c;
    try { c = JSON.parse(text); } catch (e) { return Promise.reject(new Error('不是合法的 JSON 文件')); }
    if (!c || typeof c !== 'object') { return Promise.reject(new Error('配置内容为空')); }

    var put = function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

    if (c.ui) {
      if (c.ui.theme) { put('dash.theme', c.ui.theme); }
      if (c.ui.themeMode) { put('dash.themeMode', c.ui.themeMode); }
      ['hour12', 'showSeconds', 'wakeLock', 'nightQuiet', 'nqDim', 'burnShift'].forEach(function (k) {
        if (c.ui[k] !== undefined) { put('dash.' + k, c.ui[k]); }
      });
    }
    if (c.weather) { put('dash.weather.cfg', c.weather); }
    if (c.background) { put('dash.bg.cfg', c.background); }
    if (c.ai) { put('dash.ai.cfg', c.ai); }
    if (c.events) { put('dash.events', c.events); }
    if (c.remind) { put('dash.remind.cfg', c.remind); }
    if (c.timers) {
      if (c.timers.cfg) { put('dash.timers.cfg', c.timers.cfg); }
      if (c.timers.list) { put('dash.timers.list', c.timers.list); }
      if (c.timers.presets) { put('dash.timers.presets', c.timers.presets); }
    }
    if (c.alarms) {
      if (c.alarms.cfg) { put('dash.alarms.cfg', c.alarms.cfg); }
      if (c.alarms.list) { put('dash.alarms.list', c.alarms.list); }
    }

    var imgs = c.backgroundImages || [];
    return restoreImages(imgs).then(function (meta) {
      if (imgs.length) { put('dash.bg.meta', meta); }
      var msg = '导入成功' + (imgs.length ? ('（含 ' + meta.length + ' 张背景图）') : '') + '，1 秒后自动重新载入…';
      var el = $('[data-cfg-note]');
      if (el) { el.textContent = msg; }
      setTimeout(function () { location.reload(); }, 1000);
      return msg;
    });
  }

  function bindDataUI() {
    $('#cfgExport').addEventListener('click', doExport);
    $('#cfgImportBtn').addEventListener('click', function () { $('#cfgFile').click(); });
    $('#cfgFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) { return; }
      var input = this;
      var fr = new FileReader();
      fr.onload = function () {
        doImport(String(fr.result)).catch(function (e) {
          var el = $('[data-cfg-note]');
          if (el) { el.textContent = '导入失败：' + ((e && e.message) || e); }
        });
        input.value = '';
      };
      fr.onerror = function () {
        var el = $('[data-cfg-note]');
        if (el) { el.textContent = '读取文件失败。'; }
        input.value = '';
      };
      fr.readAsText(f);
    });
  }

  /* -------------------------------------------- 外观设置回填（第六阶段） */
  function syncAppearanceSettings() {
    $$('[data-seg="themeMode"] button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-val') === state.themeMode);
    });
    var segOn = function (name, on) {
      $$('[data-seg="' + name + '"] button').forEach(function (b) {
        b.classList.toggle('on', +b.getAttribute('data-val') === (on ? 1 : 0));
      });
    };
    segOn('nightQuiet', state.nightQuiet);
    segOn('burnShift', state.burnShift);
    $$('[data-seg="burnMode"] button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-val') === state.burnMode);
    });
    $$('[data-seg="burnMin"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === +state.burnMinutes);
    });
    var ba = $('#burnAmp');
    if (ba && document.activeElement !== ba) { ba.value = state.burnAmp; }
    var bl = $('[data-burn-amp]');
    if (bl) { bl.textContent = state.burnAmp; }
    var d = $('#nqDim');
    if (d && document.activeElement !== d) { d.value = state.nqDim; }
    var l = $('[data-nq-dim]');
    if (l) { l.textContent = state.nqDim; }
  }

  /* --------------------------------------------- 天气设置面板交互（第二阶段） */
  function bindWeatherUI() {
    var cityList = $('#cityList');

    function doSearch() {
      var q = $('#cityInput').value.trim();
      if (!q) { return; }
      cityList.innerHTML = '<div class="city-empty">搜索中…</div>';
      Weather.searchCity(q).then(function (arr) {
        if (!arr.length) { cityList.innerHTML = '<div class="city-empty">没找到这个城市</div>'; return; }
        cityList.innerHTML = arr.map(function (c) {
          var payload = JSON.stringify(c).replace(/'/g, '&#39;');
          return '<div class="city-item" data-city=\'' + payload + '\'>' +
            '<span class="city-name">' + c.name + '</span>' +
            '<span class="city-adm">' + [c.admin, c.country].filter(Boolean).join(' · ') + '</span></div>';
        }).join('');
      }).catch(function (e) {
        cityList.innerHTML = '<div class="city-empty">搜索失败：' + (e.message || e) + '</div>';
      });
    }

    $('#citySearch').addEventListener('click', doSearch);
    $('#cityInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { doSearch(); } });

    cityList.addEventListener('click', function (e) {
      var item = e.target.closest('[data-city]');
      if (!item) { return; }
      var c = JSON.parse(item.getAttribute('data-city'));
      Weather.setCfg({ place: { name: c.name, lat: c.lat, lon: c.lon, id: c.id || '' } });
      cityList.innerHTML = '';
      $('#cityInput').value = '';
      syncSettings();
      refreshWeather(true);
    });

    $('#qwHost').addEventListener('change', function () {
      Weather.setCfg({ host: this.value.trim() }); syncSettings();
    });
    $('#qwKey').addEventListener('change', function () {
      Weather.setCfg({ key: this.value.trim() }); syncSettings();
    });

    $$('[data-field]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var fields = {};
        for (var k in Weather.cfg.fields) {
          if (Object.prototype.hasOwnProperty.call(Weather.cfg.fields, k)) { fields[k] = Weather.cfg.fields[k]; }
        }
        fields[cb.getAttribute('data-field')] = cb.checked ? 1 : 0;
        Weather.setCfg({ fields: fields });
        renderWeather();
      });
    });

    $('#wxRefresh').addEventListener('click', function () { refreshWeather(true); });

    $('#wxTest').addEventListener('click', function () {
      var n = $('[data-weather-note]');
      n.textContent = '正在测试连接…';
      Weather.testConnection().then(function (r) {
        n.textContent = (r.ok ? '✓ 连接正常（' + r.ms + ' ms）：' : '✗ 连接失败（' + r.ms + ' ms）：') + r.msg;
        if (r.ok) { refreshWeather(true); }
      });
    });

    $('#wxLocate').addEventListener('click', function () {
      var n = $('[data-weather-note]');
      n.textContent = '正在定位…';
      Weather.locateAndSave().then(function (p) {
        n.textContent = '✓ 已定位到 ' + p.name + '，正在拉取天气…';
        return refreshWeather(true);
      }).catch(function (e) {
        n.textContent = '✗ ' + (e.message || e) + '，请在下方手动搜索城市。';
      });
    });

    $('#resetAll').addEventListener('click', function () {
      if (!window.confirm('恢复默认设置？主题、天气配置与缓存会清空（自定义事件与对话记录保留）。')) { return; }
      try {
        ['dash.theme', 'dash.hour12', 'dash.showSeconds', 'dash.wakeLock',
          'dash.weather.cfg', 'dash.weather.cache'].forEach(function (k) {
          localStorage.removeItem(k);
        });
      } catch (e) {}
      location.reload();
    });
  }

  /* ------------------------------------------------------ 电量 / 存储 / 网络 */
  function renderBattery() {
    var pct = Math.round(state.battery.level * 100);
    $$('[data-batt-pct]').forEach(function (el) { el.textContent = pct + '%'; });
    $$('[data-batt-state]').forEach(function (el) {
      el.textContent = state.battery.charging ? (pct >= 100 ? '已充满' : '充电中') : '未充电';
    });
    $$('.batt-fill').forEach(function (el) {
      el.setAttribute('width', (47 * state.battery.level).toFixed(1));
    });
  }

  function renderSystem() {
    $$('[data-store]').forEach(function (el) { el.textContent = Math.round(state.storage) + '%'; });
    $$('[data-net]').forEach(function (el) { el.textContent = state.online ? '已连接' : '离线'; });
    // 平板温度：只有 Android 壳的桥接才拿得到，浏览器里永远是 --
    $$('[data-temp]').forEach(function (el) {
      el.textContent = (state.temp == null || !isFinite(state.temp))
        ? '--'
        : (Math.round(state.temp * 10) / 10) + '°C';
    });
  }

  /* -------------------------------------------- Android 壳桥接（第四阶段） */
  var NATIVE = window.Native || { available: false };
  var nativeTimer = null;

  /** 原生电量（含温度）——比网页 Battery API 全，也是温度的**唯一**来源 */
  function nativeBatteryTick() {
    if (!NATIVE.available) { return; }
    var b = NATIVE.battery();
    if (!b) { return; }
    if (b.level != null) { state.battery.level = b.level / 100; }
    state.battery.charging = !!b.charging;
    state.battery.full = !!b.full;
    state.temp = (b.temperature == null) ? null : b.temperature;
    state.sim.battery = false;
    renderBattery();
    renderSystem();
  }

  /** 原生存储占用 */
  function nativeStorageTick() {
    if (!NATIVE.available) { return; }
    var s = NATIVE.storage();
    if (!s || s.usedPercent == null) { return; }
    state.storage = s.usedPercent;
    state.storageFreeGB = s.freeGB;
    state.sim.storage = false;
    renderSystem();
  }

  function syncNativeSettings() {
    if (!NATIVE.available) { return; }
    var on = NATIVE.getAutoStart();
    $$('[data-seg="nativeAutoStart"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === (on ? 1 : 0));
    });
    var d = NATIVE.device() || {};
    var a = NATIVE.appInfo() || {};
    var el = $('[data-native-note]');
    if (el) {
      el.textContent = '运行在 Android 壳内：' + (d.manufacturer || '') + ' ' + (d.model || '') +
        ' · Android ' + (d.android || '?') + '（API ' + (d.sdk || '?') + '）' +
        ' · 系统 WebView ' + (d.webview || '未知') +
        ' · 应用 ' + (a.versionName || '?') + '。' +
        '常驻模式默认关闭；开启后会有一条常驻通知，并在开机后自动启动、崩溃后自动恢复。';
    }
  }

  function probeBattery() {
    if (NATIVE.available) { nativeBatteryTick(); return; }   // 壳里走原生，更准也有温度
    if (!navigator.getBattery) { state.sim.battery = true; syncSettings(); return; }
    navigator.getBattery().then(function (b) {
      state.sim.battery = false;
      var upd = function () {
        state.battery.level = b.level;
        state.battery.charging = b.charging;
        renderBattery();
      };
      upd();
      syncSettings();
      b.addEventListener('levelchange', upd);
      b.addEventListener('chargingchange', upd);
    }).catch(function () { state.sim.battery = true; syncSettings(); });
  }

  function probeStorage() {
    if (NATIVE.available) { nativeStorageTick(); return; }   // 壳里走原生，网页拿不到真实占用
    if (!navigator.storage || !navigator.storage.estimate) { state.sim.storage = true; syncSettings(); return; }
    navigator.storage.estimate().then(function (e) {
      var pct = e.quota ? (e.usage / e.quota) * 100 : 0;
      /* file:// 下配额极大、占用极小，算出来恒为 0%，没有参考价值 —— 此时保留占位值 */
      if (pct < 1) { state.sim.storage = true; syncSettings(); return; }
      state.sim.storage = false;
      state.storage = pct;
      renderSystem();
      syncSettings();
    }).catch(function () { state.sim.storage = true; syncSettings(); });
  }

  /* ------------------------------------------- AI 问候语（第五阶段） */
  var greetPick = null;   /* 本地兜底句保持稳定，只有上下文随天气/日期更新 */
  var greetTimer = null;

  /** 当前该显示的问候语：优先用 AI 上一次成功的结果，否则用内置兜底句 */
  function greetingText() {
    if (window.AI && AI.cfg.enabled) {
      var c = AI.getGreeting();
      if (c && c.text) { return c.text; }
    }
    if (!greetPick) {
      var pool = GREET[periodOf(new Date().getHours())];
      greetPick = pool[Math.floor(Math.random() * pool.length)];
    }
    return greetPick[0] + '\n' + greetPick[1];
  }

  function greetingCtx() {
    var w = state.weather || {};
    var hol = Lunar.currentHoliday(new Date());
    var s = (w.cond || '--') + ' ' + (w.temp == null ? '--' : w.temp) + '°';
    if (hol) { s += ' · ' + hol.label + '还剩 ' + hol.daysLeft + ' 天'; }
    return s;
  }

  function renderGreeting(reset) {
    if (reset) { greetPick = null; }
    var txt = greetingText();
    $$('[data-greeting]').forEach(function (el) {
      el.textContent = txt;
      el.title = txt;
      el.classList.toggle('long', txt.length > 34);
    });
    var el = $('.g-ctx');
    if (el) { el.textContent = greetingCtx(); }
  }

  /** 按设置的时机生成问候语；失败就保留上一次成功的、或用内置兜底 */
  function refreshGreeting(force) {
    if (!window.AI || !AI.cfg.enabled) { renderGreeting(true); return Promise.resolve(); }
    if (!force && !AI.shouldRefreshGreeting()) { renderGreeting(false); return Promise.resolve(); }

    $$('[data-greeting]').forEach(function (el) { el.textContent = '正在生成问候语…'; });
    return AI.greet().then(function () {
      renderGreeting(false);
      if (greetTimer) { clearTimeout(greetTimer); }
      scheduleGreeting();
    }).catch(function (e) {
      renderGreeting(false);
      setAiNote('问候语生成失败：' + ((e && e.message) || e) + '（已回退到上一次的内容）');
    });
  }

  function scheduleGreeting() {
    if (greetTimer) { clearTimeout(greetTimer); greetTimer = null; }
    if (!window.AI || !AI.cfg.enabled) { return; }
    var ms = AI.nextGreetDelayMs();
    if (!ms || ms <= 0) { return; }
    greetTimer = setTimeout(function () { refreshGreeting(true); }, Math.min(ms, 6 * 3600 * 1000));
  }

  /* ---------------------------------------------------- 对话（多轮 + 流式） */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderChat() {
    var box = $('#chatBody');
    if (!box) { return; }
    var list = (window.AI ? AI.history() : []);
    if (!list.length) {
      box.innerHTML = '<div class="bubble sys">还没有对话。问点什么吧——' +
        '我会带上当前的时间、天气、农历和假期信息来回答。</div>';
      return;
    }
    box.innerHTML = list.map(function (m) {
      var cls = m.role === 'user' ? 'me' : 'ai';
      return '<div class="bubble ' + cls + '">' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function pushSys(text) {
    var box = $('#chatBody');
    if (!box) { return; }
    var d = document.createElement('div');
    d.className = 'bubble sys';
    d.textContent = text;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  var chatBusy = false;

  function sendChat() {
    if (chatBusy) { return; }
    var input = $('#chatInput');
    var t = input.value.trim();
    if (!t) { return; }

    if (!window.AI || !AI.cfg.enabled) {
      pushSys('AI 未启用：打开右上角齿轮 → 「AI 问候与对话」→ 启用，并填写 API 地址、Key 与模型名称。');
      return;
    }
    if (!AI.cfg.key) {
      pushSys('还没填 API Key。设置 → AI 问候与对话 → API Key。');
      return;
    }

    input.value = '';
    AI.pushHistory('user', t);
    renderChat();

    var box = $('#chatBody');
    var bub = document.createElement('div');
    bub.className = 'bubble ai';
    bub.textContent = '…';
    box.appendChild(bub);
    box.scrollTop = box.scrollHeight;

    chatBusy = true;
    var acc = '';
    var onDelta = function (delta, full) {
      acc = full;
      bub.textContent = acc;
      box.scrollTop = box.scrollHeight;
    };

    AI.ask(t, onDelta).then(function (text) {
      acc = text || acc;
      bub.textContent = acc || '(模型返回了空内容)';
      AI.pushHistory('assistant', acc);
      chatBusy = false;
      renderChat();
    }).catch(function (e) {
      bub.className = 'bubble sys';
      bub.textContent = '请求失败：' + ((e && e.message) || e);
      chatBusy = false;
    });
  }

  /* ---------------------------------------------------------------- 抽屉层 */
  var IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  /* 聚焦输入框时禁止滚动，否则浏览器会把离屏的抽屉输入框滚进视口 */
  function focusChat() {
    var inp = $('#chatInput');
    try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
    window.scrollTo(0, 0);
  }

  function openDrawer(id) {
    $('#overlay').classList.add('on');
    $('#' + id).classList.add('on');
    $('#' + id).setAttribute('aria-hidden', 'false');
    window.scrollTo(0, 0);
    if (id === 'chatDrawer') { renderChat(); }
    /* 设置每次打开都回到分类列表，别停在上次那个二级页上让人找不着北 */
    if (id === 'settingsDrawer') { setGo('home'); }
  }
  function closeAll() {
    $('#overlay').classList.remove('on');
    $$('.drawer').forEach(function (el) { el.classList.remove('on'); el.setAttribute('aria-hidden', 'true'); });
    $$('.modal').forEach(function (el) {
      el.classList.remove('on');
      el.setAttribute('aria-hidden', 'true');
    });
    /* 闹钟编辑态也一起收起来，免得下次打开还停在半截表单上 */
    if (window.Alarms && Alarms.isEditing()) { Alarms.editCancel(); }
  }

  /* ----------------------------------------------- 主题模式 / 夜间勿扰 / 防烧屏 */
  var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function paintTheme(t, auto) {
    state.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    if (!auto) { state.manualTheme = t; LS.set('theme', t); }
    $('#icoTheme').innerHTML = t === 'light' ? SUN : MOON;
    $$('[data-seg="theme"] button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-val') === t);
    });
    if (window.Background) { Background.setTheme(t); }
  }

  /** 用户手动选主题：同时把「主题模式」拉回手动 */
  function applyTheme(t) {
    state.themeMode = 'manual';
    LS.set('themeMode', 'manual');
    paintTheme(t, false);
    applyAuto();
    syncSettings();
  }

  function isNightNow() {
    return window.Background ? (Background.currentSlot() === 'night') : false;
  }

  function resolveTheme() {
    if (state.nightQuiet && isNightNow()) { return 'dark'; }
    if (state.themeMode === 'time') { return isNightNow() ? 'dark' : 'light'; }
    if (state.themeMode === 'system') { return (mqDark && mqDark.matches) ? 'dark' : 'light'; }
    return state.manualTheme;
  }

  /** 定时任务：算出现在该用哪套主题、该压多暗 */
  function applyAuto() {
    var want = resolveTheme();
    if (want !== state.theme) { paintTheme(want, true); }
    var dim = (state.nightQuiet && isNightNow()) ? (state.nqDim / 100) : 0;
    var el = $('#dim');
    if (el) { el.style.opacity = dim; }
    document.body.classList.toggle('night-quiet', state.nightQuiet && isNightNow());
  }

  /* ------------------------------------------------ 防烧屏位移引擎
   * 思路：整块界面（含背景图）在若干位置之间极缓慢轮换，构图完全不变。
   * 做法：按设置动态生成 @keyframes 注入 #burnStyle，挂在 .mod / .bg-img 的
   *       translate 上，交给合成器跑——不占主线程，也不触发重排。
   *   step   阶梯偏移：绕原位走一圈再回到原点，经典 pixel shift
   *   drift  缓慢漂移：关键点之间线性过渡，肉眼几乎察觉不到
   *   jitter 随机抖动：固定种子伪随机，轨迹可复现（不会一刷新就变）
   */
  var BURN_MODES = {
    step:   { points: 10, timing: 'steps(1, end)', label: '阶梯偏移' },
    drift:  { points: 12, timing: 'linear',        label: '缓慢漂移' },
    jitter: { points: 16, timing: 'steps(1, end)', label: '随机抖动' }
  };
  var burnPhase = 0;

  function seededRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function burnPoints(mode, amp) {
    var n = (BURN_MODES[mode] || BURN_MODES.step).points;
    var pts = [], i, a;
    if (mode === 'drift') {
      for (i = 0; i < n; i++) {
        var t = i / n * Math.PI * 2;
        pts.push([
          +(amp * Math.sin(t)).toFixed(2),
          +(amp * Math.sin(t * 1.7 + 1.1)).toFixed(2)
        ]);
      }
    } else if (mode === 'jitter') {
      var rnd = seededRandom(20261006);
      for (i = 0; i < n; i++) {
        pts.push([
          Math.round((rnd() * 2 - 1) * amp),
          Math.round((rnd() * 2 - 1) * amp)
        ]);
      }
    } else {
      pts.push([0, 0]);
      for (i = 0; i < 8; i++) {
        a = i * Math.PI / 4;
        pts.push([Math.round(amp * Math.cos(a)), Math.round(amp * Math.sin(a))]);
      }
      pts.push([0, 0]);
    }
    return pts;
  }

  function burnSegSeconds() {
    return Math.max(1, +state.burnMinutes || 5) * 60;
  }

  function applyBurn() {
    var st = document.getElementById('burnStyle');
    if (!st) {
      st = document.createElement('style');
      st.id = 'burnStyle';
      document.head.appendChild(st);
    }
    var on = !!state.burnShift;
    document.body.classList.toggle('burn-on', on);
    if (!on) { st.textContent = ''; return; }

    var mode = BURN_MODES[state.burnMode] ? state.burnMode : 'step';
    var amp = Math.max(1, Math.min(16, +state.burnAmp || 4));
    var seg = burnSegSeconds();
    var pts = burnPoints(mode, amp);
    var total = seg * pts.length;

    // 两套关键帧：.mod 只要平移，.bg-img 要把自己的 scale(1.06) 一起带上。
    // 用 transform 而不是 translate 属性——后者 Chrome 104 才支持。
    var modCss = '@keyframes dashBurnMod {\n';
    var bgCss = '@keyframes dashBurnBg {\n';
    for (var i = 0; i < pts.length; i++) {
      var pct = (i / pts.length * 100).toFixed(3) + '%';
      var tr = 'translate(' + pts[i][0] + 'px,' + pts[i][1] + 'px)';
      modCss += '  ' + pct + ' { transform: ' + tr + '; }\n';
      bgCss += '  ' + pct + ' { transform: ' + tr + ' scale(1.06); }\n';
    }
    var tr0 = 'translate(' + pts[0][0] + 'px,' + pts[0][1] + 'px)';
    modCss += '  100% { transform: ' + tr0 + '; }\n}\n';
    bgCss += '  100% { transform: ' + tr0 + ' scale(1.06); }\n}\n';
    st.textContent = modCss + bgCss;

    burnPhase = burnPhase % total;
    var timing = BURN_MODES[mode].timing;
    var tail = total + 's ' + timing + ' -' + burnPhase + 's infinite';
    document.body.style.setProperty('--burn-anim-mod', 'dashBurnMod ' + tail);
    document.body.style.setProperty('--burn-anim-bg', 'dashBurnBg ' + tail);
  }

  /** 手动前进一步，方便当场看效果 */
  function burnStep() {
    if (!state.burnShift) { return; }
    var pts = burnPoints(state.burnMode, +state.burnAmp || 4);
    var total = burnSegSeconds() * pts.length;
    burnPhase = (burnPhase + burnSegSeconds()) % total;
    applyBurn();
  }

  /* -------------------------------------------------------------- 日期详情 */
  var modalKey = null;

  function openDate(key) {
    var p = key.split('-');
    var y = +p[0], m = +p[1], d = +p[2];
    var info = Lunar.dayInfo(y, m, d, new Date());
    modalKey = key;

    $('#dtDate').textContent = y + '年' + m + '月' + d + '日 · ' + info.weekCn;
    $('#dtSub').textContent = info.lunar.full + '　' + (info.term ? info.term : '');

    var tags = [];
    if (info.festival) { tags.push('<span class="tag festival">' + info.festival + '</span>'); }
    if (info.term && info.term !== info.festival) { tags.push('<span class="tag term">' + info.term + '</span>'); }
    if (info.holiday) { tags.push('<span class="tag">' + info.holiday.label + '</span>'); }
    $('#dtTags').innerHTML = tags.join('');

    renderEvents();
    $('#overlay').classList.add('on');
    $('#dateModal').classList.add('on');
  }

  function renderEvents() {
    var list = state.events[modalKey] || [];
    $('#dtEvents').innerHTML = list.length
      ? list.map(function (t, i) {
          return '<div data-ev="' + i + '" style="cursor:pointer" title="点击删除">· ' + escapeHtml(t) + '</div>';
        }).join('')
      : '<span class="dt-empty">暂无事件</span>';
  }

  function addEvent() {
    var input = $('#evInput');
    var t = input.value.trim();
    if (!t || !modalKey) { return; }
    if (!state.events[modalKey]) { state.events[modalKey] = []; }
    state.events[modalKey].push(t);
    LS.set('events', state.events);
    input.value = '';
    renderEvents();
    renderCalendar();
  }

  /* ------------------------------------------- 计时器 / 闹钟 / 提醒（v1.7） */

  function openToolModal(id) {
    var el = $('#' + id);
    if (!el) { return; }
    $('#overlay').classList.add('on');
    el.classList.add('on');
    el.setAttribute('aria-hidden', 'false');
    window.scrollTo(0, 0);
    if (id === 'timerModal' && window.Timers) { Timers.paintModal(); }
    if (id === 'alarmModal' && window.Alarms) { Alarms.paintModal(true); }
  }

  /** 主设置里关掉某个功能时：隐藏入口卡片 + 停掉它的调度 */
  function applyToolVisibility() {
    if (!window.Timers || !window.Alarms) { return; }
    var tOn = !!Timers.cfg.enabled, aOn = !!Alarms.cfg.enabled;
    var box = $('#clockTools'), tc = $('#toolTimer'), ac = $('#toolAlarm');
    if (box) { box.hidden = !(tOn || aOn); }
    if (tc) { tc.hidden = !tOn; }
    if (ac) { ac.hidden = !aOn; }
    if (tOn) { Timers.boot(); } else { Timers.shutdown(); }
    if (aOn) { Alarms.boot(); } else { Alarms.shutdown(); }
    Timers.paint();
    Alarms.paint();
    /* 关掉时如果对应面板正开着，一并收起来 */
    if (!tOn && $('#timerModal')) { $('#timerModal').classList.remove('on'); }
    if (!aOn && $('#alarmModal')) { $('#alarmModal').classList.remove('on'); }
  }

  function segSet(name, val) {
    $$('[data-seg="' + name + '"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === (val ? 1 : 0));
    });
  }
  function setText(sel, v) { var el = $(sel); if (el) { el.textContent = v; } }

  function syncToolSettings() {
    if (!window.Timers || !window.Alarms) { return; }
    segSet('timerOn', Timers.cfg.enabled);
    segSet('alarmOn', Alarms.cfg.enabled);
  }

  function syncRemindSettings() {
    if (!window.Remind) { return; }
    var C = Remind.cfg;
    segSet('rdSound', C.sound);
    segSet('rdVibrate', C.vibrate);
    segSet('rdNotify', C.notify);
    segSet('rdFade', C.fadeIn);
    segSet('rdQuiet', C.quietTimerVibeOnly);
    $$('[data-seg="rdTone"] button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-val') === (C.tone || 'chime'));
    });
    var vol = $('#rdVolume'), snz = $('#rdSnooze');
    if (vol && document.activeElement !== vol) { vol.value = C.volume; }
    if (snz && document.activeElement !== snz) { snz.value = C.snoozeMin; }
    setText('[data-rd-vol]', C.volume);
    setText('[data-rd-snooze]', C.snoozeMin);

    var note = $('[data-rd-note]');
    if (note) {
      var bits = [];
      if (!C.sound && !C.vibrate) { bits.push('⚠ 响铃和震动都关着，到点只会有屏幕提醒。'); }
      if (C.notify) {
        if (typeof Notification === 'undefined') {
          bits.push('⚠ 当前环境不支持系统通知，实际只走屏幕提醒。');
        } else if (Notification.permission === 'granted') {
          bits.push('系统通知已授权。');
        } else {
          bits.push('⚠ 系统通知尚未授权，到点可能收不到。');
        }
      }
      note.textContent = bits.join(' ');
    }

    var an = $('[data-rd-audio-note]');
    if (an) {
      an.textContent = Remind.hasAudio()
        ? ('已存：' + (Remind.audioName() || '未命名音频') + '（存在本机，不上传）')
        : '还没导入自定义音频。';
    }
  }

  function bindToolUI() {
    /* 时钟下方的两个入口 */
    if ($('#toolTimer')) {
      $('#toolTimer').addEventListener('click', function () { openToolModal('timerModal'); });
    }
    if ($('#toolAlarm')) {
      $('#toolAlarm').addEventListener('click', function () { openToolModal('alarmModal'); });
    }
    if ($('#setOpenTimers')) {
      $('#setOpenTimers').addEventListener('click', function () { closeAll(); openToolModal('timerModal'); });
    }
    /* 点正计时条带上的某个秒表：直接切到「正计时」页并展开 */
    if ($('#clkStopwatches')) {
      $('#clkStopwatches').addEventListener('click', function (e) {
        if (!e.target.closest('[data-sw]')) { return; }
        Timers.setUiKind('up');
        openToolModal('timerModal');
      });
    }
    if ($('#setOpenAlarms')) {
      $('#setOpenAlarms').addEventListener('click', function () { closeAll(); openToolModal('alarmModal'); });
    }

    /* ---- 计时器面板 ---- */
    var run = $('#tmRunning');
    if (run) {
      run.addEventListener('click', function (e) {
        var row = e.target.closest('.tm-item');
        var b = e.target.closest('button');
        if (!row || !b) { return; }
        var id = row.getAttribute('data-id');
        var act = b.getAttribute('data-act');
        if (act === 'start') { Timers.start(id); }
        else if (act === 'pause') { Timers.pause(id); }
        else if (act === 'reset') { Timers.reset(id); }
        else if (act === 'del') { Timers.remove(id); }
      });
    }

    var ps = $('#tmPresets');
    if (ps) {
      ps.addEventListener('click', function (e) {
        var del = e.target.closest('[data-delpreset]');
        if (del) { Timers.removePreset(del.getAttribute('data-delpreset')); return; }
        if (e.target.closest('[data-new-up]')) { Timers.addUp(); return; }
        if (e.target.closest('[data-new-down]')) {
          var inp = $('#tmCustom');
          if (inp) { inp.focus(); }
          return;
        }
        var chip = e.target.closest('.tm-preset');
        if (chip && chip.getAttribute('data-sec')) {
          Timers.addDown(+chip.getAttribute('data-sec'), null, true);
        }
      });
    }

    var foot = $('#tmFoot');
    if (foot) {
      foot.addEventListener('click', function (e) {
        if (e.target.closest('[data-clearfinished]')) { Timers.clearFinished(); }
      });
    }

    function customSec() {
      var inp = $('#tmCustom');
      return inp ? Timers.parseDur(inp.value) : 0;
    }
    function clearCustom() { var inp = $('#tmCustom'); if (inp) { inp.value = ''; } }

    if ($('#tmStartNow')) {
      $('#tmStartNow').addEventListener('click', function () {
        var sec = customSec();
        if (sec <= 0) { return; }
        Timers.addDown(sec, null, true);
        clearCustom();
      });
    }
    if ($('#tmSavePreset')) {
      $('#tmSavePreset').addEventListener('click', function () {
        var sec = customSec();
        if (sec <= 0) { return; }
        Timers.addPreset(sec);
        clearCustom();
      });
    }
    if ($('#tmCustom')) {
      $('#tmCustom').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { $('#tmStartNow').click(); }
      });
    }

    /* ---- 闹钟面板 ---- */
    var al = $('#alList');
    if (al) {
      al.addEventListener('click', function (e) {
        var tg = e.target.closest('[data-toggle]');
        if (tg) {
          var id = tg.getAttribute('data-toggle');
          var cur = Alarms.list().filter(function (x) { return x.id === id; })[0];
          Alarms.toggle(id, !(cur && cur.on));
          return;
        }
        var dl = e.target.closest('[data-del]');
        if (dl) { Alarms.remove(dl.getAttribute('data-del')); return; }
        var ed = e.target.closest('[data-edit]');
        if (ed) { Alarms.editStart(ed.getAttribute('data-edit')); }
      });
    }
    if ($('#alAdd')) {
      $('#alAdd').addEventListener('click', function () { Alarms.editStart('new'); });
    }
    if ($('#alSave')) { $('#alSave').addEventListener('click', function () { Alarms.editSave(); }); }
    if ($('#alCancel')) { $('#alCancel').addEventListener('click', function () { Alarms.editCancel(); }); }

    var aq = $('#alQuick');
    if (aq) {
      aq.addEventListener('click', function (e) {
        var q = e.target.closest('[data-quick]');
        if (!q) { return; }
        var s = q.getAttribute('data-quick');
        Alarms.setEditingDays(s ? s.split(',').map(Number) : []);
      });
    }
    var ad = $('#alDays');
    if (ad) {
      ad.addEventListener('click', function (e) {
        var d = e.target.closest('[data-day]');
        if (!d) { return; }
        Alarms.toggleEditingDay(+d.getAttribute('data-day'));
      });
    }

    /* ---- 提醒浮层 ---- */
    if ($('#rdStopBtn')) { $('#rdStopBtn').addEventListener('click', function () { Remind.stop(); }); }
    if ($('#rdSnoozeBtn')) { $('#rdSnoozeBtn').addEventListener('click', function () { Remind.snooze(); }); }

    /* ---- 提醒设置 ---- */
    if ($('#rdTest')) {
      $('#rdTest').addEventListener('click', function () {
        Remind.unlock();
        Remind.test();
      });
    }
    if ($('#rdPickAudio')) {
      $('#rdPickAudio').addEventListener('click', function () { $('#rdAudioFile').click(); });
    }
    if ($('#rdAudioFile')) {
      $('#rdAudioFile').addEventListener('change', function () {
        var f = this.files && this.files[0];
        this.value = '';
        if (!f) { return; }
        var note = $('[data-rd-audio-note]');
        if (note) { note.textContent = '正在保存音频…'; }
        Remind.pickAudio(f, f.name).then(function () {
          Remind.setCfg({ tone: 'custom' });
          syncRemindSettings();
        }).catch(function (err) {
          if (note) { note.textContent = '导入失败：' + ((err && err.message) || err); }
        });
      });
    }
    if ($('#rdClearAudio')) {
      $('#rdClearAudio').addEventListener('click', function () {
        Remind.clearAudio();
        if (Remind.cfg.tone === 'custom') { Remind.setCfg({ tone: 'chime' }); }
        syncRemindSettings();
      });
    }
    if ($('#rdVolume')) {
      $('#rdVolume').addEventListener('input', function () {
        Remind.setCfg({ volume: +this.value });
        syncRemindSettings();
      });
    }
    if ($('#rdSnooze')) {
      $('#rdSnooze').addEventListener('input', function () {
        Remind.setCfg({ snoozeMin: +this.value });
        syncRemindSettings();
      });
    }
  }

  /* ------------------------------------------- 设置：一级分类 → 二级页（v1.8）
   * DOM 里所有控件都还在，只是被 .set-page 分组显示/隐藏。
   * 这里只负责「切页 + 回填每个分类右侧的当前值摘要」。 */
  var SET_CATS = [
    { id: 'appearance', name: '外观与主题' },
    { id: 'screen',     name: '屏幕与防烧屏' },
    { id: 'weather',    name: '天气' },
    { id: 'background', name: '背景' },
    { id: 'clock',      name: '计时器与闹钟' },
    { id: 'remind',     name: '提醒方式' },
    { id: 'ai',         name: 'AI 问候与对话' },
    { id: 'data',       name: '数据与系统' }
  ];
  var setPage = 'home';

  function setGo(page) {
    page = page || 'home';
    var body = $('#setBody');
    if (!body) { return; }
    /* 切走前先把焦点交出去，免得藏在隐藏页里的输入框还占着焦点 */
    try { if (document.activeElement && body.contains(document.activeElement)) { document.activeElement.blur(); } } catch (e) {}
    setPage = page;
    $$('#setBody .set-page').forEach(function (el) {
      el.classList.toggle('on', el.getAttribute('data-page') === page);
    });
    body.scrollTop = 0;
    var back = $('#setBack');
    if (back) { back.hidden = (page === 'home'); }
    var title = $('#setTitle');
    if (title) {
      var c = SET_CATS.filter(function (x) { return x.id === page; })[0];
      title.textContent = c ? c.name : '设置';
    }
    syncCatValues();
  }
  function setCurrentPage() { return setPage; }

  /** 每个分类右侧那句摘要，让人不进二级页也知道现在是啥状态 */
  function catText(id) {
    if (id === 'appearance') {
      var t = state.theme === 'dark' ? '深色数据看板' : '浅色编辑网格';
      var m = { manual: '手动', time: '跟随时间', system: '跟随系统' }[state.themeMode] || '手动';
      return t + ' · ' + m;
    }
    if (id === 'screen') {
      var p = [];
      p.push('常亮' + (state.wakeLock ? '开' : '关'));
      if (state.nightQuiet) { p.push('夜间勿扰'); }
      p.push('防烧屏' + (state.burnShift ? '开' : '关'));
      return p.join(' · ');
    }
    if (id === 'weather') {
      var w = Weather.cfg || {};
      var src = w.provider === 'qweather' ? '和风天气' : 'Open-Meteo';
      return src + ' · ' + ((w.place && w.place.name) ? w.place.name : '未设城市');
    }
    if (id === 'background') {
      var b = Background.cfg || {};
      return (b.mode === 'image' ? '图片' : '纯色底') + ' · ' + Background.list().length + ' 张';
    }
    if (id === 'clock') {
      return '计时器' + (Timers.cfg.enabled ? '开' : '关') +
        ' · 闹钟' + (Alarms.cfg.enabled ? '开' : '关');
    }
    if (id === 'remind') {
      var r = Remind.cfg || {};
      var tn = (r.tone === 'custom')
        ? (Remind.audioName() || '自定义音频')
        : ((Remind.tones[r.tone] && Remind.tones[r.tone].label) || '叮咚');
      var ch = [];
      if (r.sound) { ch.push('铃声'); }
      if (r.vibrate) { ch.push('震动'); }
      if (r.notify) { ch.push('通知'); }
      return tn + ' · ' + (ch.length ? ch.join('/') : '仅屏幕浮层');
    }
    if (id === 'ai') {
      var a = AI.cfg || {};
      return (a.enabled ? '已开启' : '已关闭') + (a.model ? ' · ' + a.model : '');
    }
    if (id === 'data') {
      return state.exportFull ? '导出含 Key 与背景图' : '导出不含 Key';
    }
    return '';
  }

  function syncCatValues() {
    $$('[data-cat]').forEach(function (el) {
      el.textContent = catText(el.getAttribute('data-cat'));
    });
  }

  function bindSettingsNav() {
    var body = $('#setBody');
    if (body) {
      body.addEventListener('click', function (e) {
        var cat = e.target.closest('[data-go]');
        if (cat) { setGo(cat.getAttribute('data-go')); }
      });
    }
    if ($('#setBack')) {
      $('#setBack').addEventListener('click', function () { setGo('home'); });
    }
  }

  /** Esc：在二级页先退回分类列表，在分类列表才关掉抽屉 */
  function escapeAction() {
    var d = $('#settingsDrawer');
    if (d && d.classList.contains('on') && setPage !== 'home') { setGo('home'); return; }
    closeAll();
  }

  /* ------------------------------------------------------------------ 主题 */
  var SUN = '<circle cx="12" cy="12" r="4.4"/><path d="M12 2.4v2.6M12 19v2.6M2.4 12h2.6M19 12h2.6M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9"/>';
  var MOON = '<path d="M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5a8.6 8.6 0 1 0 10.9 10.9z"/>';

  /* ------------------------------------------------------------------ 设置 */
  function syncSettings() {
    $$('[data-seg="hour12"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === state.hour12);
    });
    $$('[data-seg="showSeconds"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === state.showSeconds);
    });
    $$('[data-seg="wakeLock"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === state.wakeLock);
    });

    /* --- 天气设置回填 --- */
    var C = Weather.cfg;
    $$('[data-seg="provider"] button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-val') === C.provider);
    });
    $$('[data-seg="days"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === C.days);
    });
    $$('[data-seg="refreshHours"] button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-val') === C.refreshHours);
    });
    $$('[data-field]').forEach(function (cb) {
      cb.checked = !!C.fields[cb.getAttribute('data-field')];
    });
    var hostEl = $('#qwHost'), keyEl = $('#qwKey');
    if (hostEl && document.activeElement !== hostEl) { hostEl.value = C.host || ''; }
    if (keyEl && document.activeElement !== keyEl) { keyEl.value = C.key || ''; }
    document.body.classList.toggle('prov-qweather', C.provider === 'qweather');

    var lbl = $('[data-city-label]');
    if (lbl) {
      lbl.textContent = C.place.name + '（' + (+C.place.lat).toFixed(2) + ', ' + (+C.place.lon).toFixed(2) + '）';
    }

    var w = state.weather || {};
    var srcName = { 'open-meteo': 'Open-Meteo', 'qweather': '和风天气', 'mock': '内置占位' }[w.source] || '--';
    var t = w.updatedAt ? new Date(w.updatedAt) : null;
    var wnote = $('[data-weather-note]');
    if (wnote) {
      wnote.textContent = '天气：' + srcName +
        '，' + (t ? '更新于 ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) : '尚未成功获取') +
        (w.fromCache ? '（当前显示缓存）' : '') +
        (w.error ? '，失败原因：' + w.error : '') +
        '。预报 ' + C.days + ' 天，每 ' + C.refreshHours + ' 小时自动刷新。';
    }

    var notes = [];
    notes.push('系统信息：电量' + (state.sim.battery ? '模拟' : '真实') +
      '、存储' + (state.sim.storage ? '模拟' : '真实') +
      (NATIVE.available ? '、温度来自 Android 桥接。' : '、温度需 Android 壳桥接（浏览器拿不到）。'));
    notes.push('本机：' + navigator.userAgent.slice(0, 56) + '…');
    var sn = $('[data-status-note]');
    if (sn) { sn.textContent = notes.join(' '); }

    syncBgSettings();
    syncAppearanceSettings();
    syncAiSettings();
    syncNativeSettings();
    syncToolSettings();
    syncRemindSettings();
    syncCatValues();
  }

  var wakeLockObj = null;
  function toggleWakeLock(on) {
    state.wakeLock = on ? 1 : 0;
    LS.set('wakeLock', state.wakeLock);

    // 在 Android 壳里交给原生接管：不挑前台/后台，比 Wake Lock API 稳
    if (NATIVE.available) {
      NATIVE.setKeepScreenOn(!!on);
      syncSettings();
      return;
    }

    if (!on) {
      if (wakeLockObj) { wakeLockObj.release().catch(function () {}); wakeLockObj = null; }
      syncSettings();
      return;
    }
    if (!navigator.wakeLock) { syncSettings(); return; }
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLockObj = l;
    }).catch(function () {}).then(syncSettings);
  }

  /* ------------------------------------------------------------------ 事件 */
  function bind() {
    $('#overlay').addEventListener('click', closeAll);
    $$('[data-close]').forEach(function (b) {
      b.addEventListener('click', closeAll);
    });

    $$('[data-cal]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-cal');
        if (act === 'prev') { shiftMonth(-1); }
        else if (act === 'next') { shiftMonth(1); }
        else { goToday(); }
      });
    });

    $('#calGrid').addEventListener('click', function (e) {
      var cell = e.target.closest('.cal-cell');
      if (!cell) { return; }
      openDate(cell.getAttribute('data-date'));
    });

    $('#greetingBox').addEventListener('click', function () {
      openDrawer('chatDrawer');
      /* 触摸设备不自动聚焦：软键盘会遮住半屏，还可能把离屏输入框滚进视口顶歪画布 */
      if (!IS_TOUCH) { focusChat(); }
    });

    $('#chatSend').addEventListener('click', sendChat);
    $('#chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { sendChat(); }
    });

    $('#evAdd').addEventListener('click', addEvent);
    $('#evInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { addEvent(); }
    });
    $('#dtEvents').addEventListener('click', function (e) {
      var row = e.target.closest('[data-ev]');
      if (!row || !modalKey) { return; }
      state.events[modalKey].splice(+row.getAttribute('data-ev'), 1);
      LS.set('events', state.events);
      renderEvents();
      renderCalendar();
    });

    $('#controls').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) { return; }
      var act = b.getAttribute('data-act');
      if (act === 'theme') { applyTheme(state.theme === 'light' ? 'dark' : 'light'); }
      else if (act === 'settings') { openDrawer('settingsDrawer'); }
      else if (act === 'fullscreen') { toggleFullscreen(); }
    });

    $$('.seg').forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) { return; }
        var v = +b.getAttribute('data-val');
        var name = seg.getAttribute('data-seg');
        if (!name) { return; }
        if (name === 'bgSlot') { return; }   /* 背景图时段由列表自己的委托处理 */
        if (name === 'theme') { applyTheme(b.getAttribute('data-val')); }
        else if (name === 'hour12') { state.hour12 = v; LS.set('hour12', v); }
        else if (name === 'showSeconds') { state.showSeconds = v; LS.set('showSeconds', v); }
        else if (name === 'wakeLock') { toggleWakeLock(!!v); }
        else if (name === 'provider') {
          Weather.setCfg({ provider: b.getAttribute('data-val') });
          refreshWeather(true);
        }
        else if (name === 'days') { Weather.setCfg({ days: v }); refreshWeather(true); }
        else if (name === 'refreshHours') { Weather.setCfg({ refreshHours: v }); scheduleWeather(); }
        else if (name === 'bgMode') {
          Background.setCfg({ mode: b.getAttribute('data-val') });
          Background.refresh(true); Background.schedule(); syncBgSettings();
        }
        else if (name === 'bgInterval') {
          Background.setCfg({ intervalSec: v }); Background.schedule(); syncBgSettings();
        }
        else if (name === 'bgFrosted') {
          Background.setCfg({ frosted: v }); Background.applyStyle(); syncBgSettings();
        }
        else if (name === 'bgRes') {
          /* 只影响之后导入的图，已存的不重压 */
          Background.setCfg({ res: b.getAttribute('data-val') });
          syncBgSettings();
        }
        else if (name === 'themeMode') {
          state.themeMode = b.getAttribute('data-val');
          LS.set('themeMode', state.themeMode);
          applyAuto();
        }
        else if (name === 'nightQuiet') {
          state.nightQuiet = v ? 1 : 0;
          LS.set('nightQuiet', state.nightQuiet);
          applyAuto();
        }
        else if (name === 'burnShift') {
          state.burnShift = v ? 1 : 0;
          LS.set('burnShift', state.burnShift);
          burnPhase = 0;
          applyBurn();
        }
        else if (name === 'burnMode') {
          state.burnMode = b.getAttribute('data-val');
          LS.set('burnMode', state.burnMode);
          burnPhase = 0;
          applyBurn();
        }
        else if (name === 'burnMin') {
          state.burnMinutes = v;
          LS.set('burnMinutes', v);
          burnPhase = 0;
          applyBurn();
        }
        /* ---- 计时器 / 闹钟 / 提醒（v1.7）---- */
        else if (name === 'timerOn') {
          Timers.setCfg({ enabled: v ? 1 : 0 });
          applyToolVisibility();
          syncToolSettings();
        }
        else if (name === 'alarmOn') {
          Alarms.setCfg({ enabled: v ? 1 : 0 });
          applyToolVisibility();
          syncToolSettings();
        }
        else if (name === 'timerKind') {
          Timers.setUiKind(b.getAttribute('data-val'));
        }
        else if (name === 'rdSound') { Remind.setCfg({ sound: v ? 1 : 0 }); syncRemindSettings(); }
        else if (name === 'rdVibrate') { Remind.setCfg({ vibrate: v ? 1 : 0 }); syncRemindSettings(); }
        else if (name === 'rdNotify') {
          Remind.setCfg({ notify: v ? 1 : 0 });
          if (v) { Remind.requestNotify().then(function () { syncRemindSettings(); }); }
          else { syncRemindSettings(); }
        }
        else if (name === 'rdTone') {
          Remind.setCfg({ tone: b.getAttribute('data-val') });
          if (b.getAttribute('data-val') === 'custom' && !Remind.hasAudio()) {
            Remind.setCfg({ tone: 'chime' });
            var an = $('[data-rd-audio-note]');
            if (an) { an.textContent = '还没导入自定义音频，先给你切回「叮咚」。'; }
          }
          syncRemindSettings();
        }
        else if (name === 'rdFade') { Remind.setCfg({ fadeIn: v ? 1 : 0 }); syncRemindSettings(); }
        else if (name === 'rdQuiet') { Remind.setCfg({ quietTimerVibeOnly: v ? 1 : 0 }); syncRemindSettings(); }

        else if (name === 'aiEnabled') {
          AI.setCfg({ enabled: v ? 1 : 0 });
          if (v) { refreshGreeting(false); scheduleGreeting(); } else { renderGreeting(true); }
          syncAiSettings();
        }
        else if (name === 'aiStream') { AI.setCfg({ stream: v ? 1 : 0 }); syncAiSettings(); }
        else if (name === 'personaOn') {
          AI.setCfg({ personaOn: v ? 1 : 0 });
          syncAiSettings();
        }
        else if (name === 'aiMode') {
          AI.setCfg({ greetMode: b.getAttribute('data-val') });
          scheduleGreeting(); syncAiSettings();
        }
        else if (name === 'exportFull') {
          state.exportFull = v ? 1 : 0;
          LS.set('exportFull', state.exportFull);
          syncAiSettings();
        }
        else if (name === 'nativeAutoStart') {
          NATIVE.setAutoStart(!!v);
          syncNativeSettings();
        }
        renderClock(); syncSettings();
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT') {
        if (e.key === 'Escape') { escapeAction(); }
        return;
      }
      if (e.key === 'ArrowLeft') { shiftMonth(-1); }
      else if (e.key === 'ArrowRight') { shiftMonth(1); }
      else if (e.key === 't' || e.key === 'T') { goToday(); }
      else if (e.key === 'd' || e.key === 'D') { applyTheme(state.theme === 'light' ? 'dark' : 'light'); }
      else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
      else if (e.key === 'Escape') { escapeAction(); }
    });

    /* 触摸滑动翻月 */
    var gx = null;
    var grid = $('#calGrid');
    grid.addEventListener('touchstart', function (e) {
      gx = e.touches[0].clientX;
    }, { passive: true });
    grid.addEventListener('touchend', function (e) {
      if (gx === null) { return; }
      var dx = e.changedTouches[0].clientX - gx;
      if (Math.abs(dx) > 60) { shiftMonth(dx < 0 ? 1 : -1); }
      gx = null;
    });

    window.addEventListener('resize', function () { fitStage(); });
    window.addEventListener('load', function () { fitStageRetry(); });
    window.addEventListener('orientationchange', function () { setTimeout(fitStageRetry, 200); });
    window.addEventListener('online', function () { state.online = true; renderSystem(); refreshWeather(false); });
    window.addEventListener('offline', function () { state.online = false; renderSystem(); });

    /* 唤醒后立刻补齐（平板息屏再亮） */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        renderClock(); renderDate(); tickCalendarDay();
        refreshWeather(false);
        applyAuto();
        refreshGreeting(false);      /* 该生成才生成，不会每次都打接口 */
      }
    });
  }

  function shiftMonth(d) {
    var m = state.view.m + d, y = state.view.y;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.view = { y: y, m: m };
    renderCalendar();
  }

  function goToday() {
    var d = new Date();
    state.view = { y: d.getFullYear(), m: d.getMonth() + 1 };
    renderCalendar();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || function () {})
        .call(document.documentElement).catch(function () {});
    } else {
      document.exitFullscreen().catch(function () {});
    }
  }

  /* 跨天时把日历拉回今天 */
  var lastDay = new Date().getDate();
  function tickCalendarDay() {
    var d = new Date();
    if (d.getDate() !== lastDay) {
      lastDay = d.getDate();
      renderCalendar();
      refreshGreeting(true);   /* 跨天：重新生成问候语 */
    }
  }

  /* ------------------------------------------------------------------ 启动 */
  function init() {
    /* 支持 ?theme=dark|light 强制主题（Kiosk 部署 / 截图自检用） */
    try {
      var qs = new URLSearchParams(location.search);
      var t = qs.get('theme');
      if (t === 'dark' || t === 'light') {
        state.manualTheme = t;
        state.themeMode = 'manual';
      }
    } catch (e) {}

    if (window.AI) {
      AI.setContextProvider(buildAiContext);
      AI.seedPersonas();      /* 首次启动把内置人设写进人设库（只种一次，删了不复活） */
    }

    /* 老引擎兼容：不支持 flex gap 就挂补丁 class（legacy.css 靠它生效） */
    if (!detectFlexGap()) {
      document.documentElement.classList.add('no-flexgap');
    }

    fitStageRetry();
    paintTheme(state.manualTheme, false);
    goToday();

    /* 天气：先用缓存 / 内置兜底把界面填满，再异步拉真实数据 */
    state.weather = Weather.readCache() || Weather.fallbackData();

    renderClock();
    renderDate();
    renderWeather();
    renderBattery();
    renderSystem();
    syncSettings();
    probeBattery();
    probeStorage();
    state.online = navigator.onLine;
    renderSystem();

    renderChat();

    setInterval(function () { renderClock(); tickCalendarDay(); }, 200);
    setInterval(renderSystem, 60 * 1000);
    setInterval(renderDate, 60 * 1000);
    setInterval(applyAuto, 60 * 1000);          /* 主题定时 / 夜间勿扰 每分钟核对 */

    /* --- Android 壳桥接初始化（浏览器里 available 为 false，整段跳过）--- */
    document.body.classList.toggle('has-native', NATIVE.available);
    if (NATIVE.available) {
      var ks = NATIVE.getKeepScreenOn();
      if (ks !== null) { state.wakeLock = ks ? 1 : 0; }
      NATIVE.setFullscreen(true);
      nativeBatteryTick();
      nativeStorageTick();
      nativeTimer = setInterval(function () { nativeBatteryTick(); nativeStorageTick(); }, 30000);
      var wb = $('#nativeWakeBtn');
      if (wb) {
        wb.addEventListener('click', function () {
          state.wakeLock = state.wakeLock ? 0 : 1;
          LS.set('wakeLock', state.wakeLock);
          NATIVE.setKeepScreenOn(!!state.wakeLock);
          syncSettings();
          NATIVE.toast(state.wakeLock ? '屏幕常亮：已开启' : '屏幕常亮：已关闭');
        });
      }
    }

    bind();
    bindWeatherUI();
    bindBgUI();
    bindAppearanceUI();
    bindAiUI();
    bindDataUI();
    bindToolUI();
    bindSettingsNav();
    applyBurn();

    /* 天气：先用缓存 / 内置兜底把界面填满，再异步拉真实数据 */
    refreshWeather(false);      /* 缓存没过期就直接用，过期才真的请求 */
    renderBgList();
    Background.start(state.theme);
    /* 存储是异步打开的（IndexedDB 探测 + 老数据迁移），好了之后再刷一次列表和容量说明 */
    if (Background.onReady) {
      Background.onReady(function () { renderBgList(); syncBgSettings(); });
    }

    /* --- 计时器 / 闹钟 / 提醒（v1.7）--- */
    if (window.Remind) { Remind.start(); }
    if (window.Timers && window.Alarms) {
      applyToolVisibility();          /* 里面会按启用开关决定要不要 boot */
    }
    syncToolSettings();
    syncRemindSettings();
    /* 页面刚打开时补一次：关页面 / 刷新期间到点的计时器和闹钟别漏掉 */
    setTimeout(function () {
      if (window.Alarms) { Alarms.catchUp(); }
      if (window.Timers) { Timers.catchUp(); }
    }, 900);

    applyAuto();
    renderGreeting(false);
    if (window.AI && AI.cfg.enabled) {
      refreshGreeting(false);   /* 到点才真的请求；否则显示上次缓存 */
      scheduleGreeting();
    }
    document.body.classList.add('ready');

    /* 支持 ?open=chat|settings|timer|alarm 直接展开面板
       （Kiosk 深链 / 截图自检用）；?remind=timer|alarm 弹一次提醒浮层，纯自检 */
    try {
      var q = new URLSearchParams(location.search);
      var op = q.get('open');
      if (op === 'chat') { openDrawer('chatDrawer'); }
      else if (op === 'settings') { openDrawer('settingsDrawer'); }
      else if (op === 'timer') { openToolModal('timerModal'); }
      else if (op === 'alarm') { openToolModal('alarmModal'); }
      /* 直接落到某个设置分类：?open=settings&setpage=weather（截图自检用） */
      var sp = q.get('setpage');
      if (op === 'settings' && sp) { setGo(sp); }
      var rd = q.get('remind');
      if (rd && window.Remind) {
        setTimeout(function () {
          Remind.fire({
            kind: rd === 'alarm' ? 'alarm' : 'timer',
            title: rd === 'alarm' ? '闹钟' : '倒计时结束',
            sub: rd === 'alarm' ? '起床 · 工作日' : '泡面',
            timeText: rd === 'alarm' ? '07:30' : '03:00'
          });
        }, 400);
      }
    } catch (e) {}

    /* 告诉 Android 壳：网页真的跑起来了。
       壳靠这个信号判断要不要走下一层兜底（换个加载方式 / 换软件渲染）。 */
    try {
      if (window.Native && Native.available && Native.pageReady) { Native.pageReady(); }
    } catch (e) {}
  }

  window.DASH = {
    state: state,
    renderCalendar: renderCalendar,
    applyTheme: applyTheme,
    applyBurn: applyBurn,
    burnStep: burnStep,
    burnPoints: burnPoints,
    BURN_MODES: BURN_MODES
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
