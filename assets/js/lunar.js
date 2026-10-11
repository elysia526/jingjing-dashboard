/* ============================================================================
 * lunar.js — 离线农历 / 二十四节气 / 节日 / 假期 数据与换算
 * ----------------------------------------------------------------------------
 * 数据范围：1900-01-31 ~ 2100-12-31
 * 完全离线，无任何网络请求。
 *
 * 【节气说明】采用经典近似公式（自 1900-01-06 起按回归年毫秒数推算），
 * 在 1900–2100 区间内绝大多数年份正确，个别年份可能差一天。
 * 若后续核对出偏差，在 TERM_FIX 中登记 "年-节气序号": 正确日 即可修正。
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* 1900–2100 年农历数据表（每年一个 16 进制数） */
  var LUNAR_INFO = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
    0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
    0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
    0x0d520                                                                                    // 2100
  ];

  var TERM_INFO = [
    0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
    263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758
  ];

  /* 节气修正表：{ "年-序号": 正确日 } —— 序号 0=小寒 … 23=冬至 */
  var TERM_FIX = {};

  var TERMS = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
               '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
               '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];

  var CN_MONTH = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  var CN_DAY = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
                '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
                '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
  var WEEK_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  var WEEK_EN = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

  /* 公历节日 */
  var SOLAR_FESTIVAL = {
    '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '3-12': '植树节', '4-1': '愚人节',
    '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节', '7-1': '建党节', '8-1': '建军节',
    '9-10': '教师节', '10-1': '国庆节', '12-25': '圣诞节'
  };

  /* 农历节日 */
  var LUNAR_FESTIVAL = {
    '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节', '7-7': '七夕',
    '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节', '12-23': '小年'
  };

  /* 法定假期 / 调休
   * 数据来源：国务院办公厅关于 2026 年部分节假日安排的通知
   *           （国办发明电〔2025〕7号，2025-11-04）
   * 后续年份按官方通知补充；用户也可在设置中自定义覆盖。 */
  var HOLIDAYS = {
    2026: {
      off: [
        { from: '2026-01-01', to: '2026-01-03', label: '元旦' },
        { from: '2026-02-15', to: '2026-02-23', label: '春节假期' },
        { from: '2026-04-04', to: '2026-04-06', label: '清明假期' },
        { from: '2026-05-01', to: '2026-05-05', label: '劳动节假期' },
        { from: '2026-06-19', to: '2026-06-21', label: '端午假期' },
        { from: '2026-09-25', to: '2026-09-27', label: '中秋假期' },
        { from: '2026-10-01', to: '2026-10-07', label: '国庆假期' }
      ],
      work: [
        { from: '2026-01-04', to: '2026-01-04', label: '调休上班' },
        { from: '2026-02-14', to: '2026-02-14', label: '调休上班' },
        { from: '2026-02-28', to: '2026-02-28', label: '调休上班' },
        { from: '2026-05-09', to: '2026-05-09', label: '调休上班' },
        { from: '2026-09-20', to: '2026-09-20', label: '调休上班' },
        { from: '2026-10-10', to: '2026-10-10', label: '调休上班' }
      ]
    }
  };

  /* ------------------------------ 基础工具 ------------------------------ */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function key(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  function toDate(y, m, d) { return new Date(y, m - 1, d); }
  function dayDiff(a, b) { return Math.round((b - a) / 86400000); }

  /* ------------------------------ 农历换算 ------------------------------ */

  function leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
  function leapDays(y) { return leapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0; }
  function monthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
  function lunarYearDays(y) {
    var i, sum = 348;
    for (i = 0x8000; i > 0x8; i >>= 1) { sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0; }
    return sum + leapDays(y);
  }

  function solar2lunar(y, m, d) {
    var offset = dayDiff(Date.UTC(1900, 0, 31), Date.UTC(y, m - 1, d));
    var i, temp = 0;
    for (i = 1900; i < 2101 && offset > 0; i++) { temp = lunarYearDays(i); offset -= temp; }
    if (offset < 0) { offset += temp; i--; }
    var ly = i;
    var leap = leapMonth(ly), isLeap = false;
    for (i = 1; i < 13 && offset > 0; i++) {
      if (leap > 0 && i === leap + 1 && !isLeap) { --i; isLeap = true; temp = leapDays(ly); }
      else { temp = monthDays(ly, i); }
      if (isLeap && i === leap + 1) { isLeap = false; }
      offset -= temp;
    }
    if (offset === 0 && leap > 0 && i === leap + 1) {
      if (isLeap) { isLeap = false; } else { isLeap = true; --i; }
    }
    if (offset < 0) { offset += temp; --i; }

    var lm = i, ld = offset + 1;
    return {
      year: ly, month: lm, day: ld, isLeap: isLeap,
      monthName: (isLeap ? '闰' : '') + CN_MONTH[lm - 1] + '月',
      dayName: CN_DAY[ld - 1],
      /* 单元格用短标签：初一显示月名 */
      short: ld === 1 ? (isLeap ? '闰' : '') + CN_MONTH[lm - 1] + '月' : CN_DAY[ld - 1],
      full: '农历' + (isLeap ? '闰' : '') + CN_MONTH[lm - 1] + '月' + CN_DAY[ld - 1]
    };
  }

  /* ------------------------------ 二十四节气 ---------------------------- */

  function termDay(y, n) {
    var fix = TERM_FIX[y + '-' + n];
    if (fix) { return fix; }
    var ms = 31556925974.7 * (y - 1900) + TERM_INFO[n] * 60000 + Date.UTC(1900, 0, 6, 2, 5);
    return new Date(ms).getUTCDate();
  }

  /* 返回当天节气名，没有则返回 null */
  function termOfDay(y, m, d) {
    var n = (m - 1) * 2;
    if (termDay(y, n) === d) { return TERMS[n]; }
    if (termDay(y, n + 1) === d) { return TERMS[n + 1]; }
    return null;
  }

  /* 返回某月两个节气的日期列表 [{name, day}] */
  function termsOfMonth(y, m) {
    var n = (m - 1) * 2;
    return [{ name: TERMS[n], day: termDay(y, n) }, { name: TERMS[n + 1], day: termDay(y, n + 1) }];
  }

  /* ------------------------------ 节日 / 假期 --------------------------- */

  function solarFestival(m, d) { return SOLAR_FESTIVAL[m + '-' + d] || null; }

  function lunarFestival(l) {
    if (l.isLeap) { return null; }
    /* 除夕：腊月最后一天 */
    if (l.month === 12) {
      var last = monthDays(l.year, 12);
      if (l.day === last) { return '除夕'; }
    }
    return LUNAR_FESTIVAL[l.month + '-' + l.day] || null;
  }

  function holidayOf(y, m, d) {
    var table = HOLIDAYS[y];
    if (!table) { return null; }
    var t = toDate(y, m, d).getTime(), i, r;
    for (i = 0; i < (table.off || []).length; i++) {
      r = table.off[i];
      if (t >= toDate(...splitYmd(r.from)).getTime() && t <= toDate(...splitYmd(r.to)).getTime()) {
        return { type: 'off', label: r.label, range: r };
      }
    }
    for (i = 0; i < (table.work || []).length; i++) {
      r = table.work[i];
      if (t >= toDate(...splitYmd(r.from)).getTime() && t <= toDate(...splitYmd(r.to)).getTime()) {
        return { type: 'work', label: r.label, range: r };
      }
    }
    return null;
  }

  function splitYmd(s) { var p = s.split('-'); return [+p[0], +p[1], +p[2]]; }

  /* 当前所处假期（含剩余天数），用于侧栏 / 状态栏文案 */
  function currentHoliday(today) {
    today = today || new Date();
    var table = HOLIDAYS[today.getFullYear()];
    if (!table) { return null; }
    for (var i = 0; i < (table.off || []).length; i++) {
      var r = table.off[i];
      var a = splitYmd(r.from), b = splitYmd(r.to);
      var s = toDate(a[0], a[1], a[2]), e = toDate(b[0], b[1], b[2]);
      if (today >= s && today <= e) {
        return { label: r.label, daysLeft: dayDiff(today, e) + 1, total: dayDiff(s, e) + 1 };
      }
    }
    return null;
  }

  /* ------------------------------ 单元格信息 ---------------------------- */

  /**
   * 返回某一天在日历格中需要展示的全部信息
   * @returns {{y,m,d,week,lunar,term,festival,holiday,subText,subType,isToday,isWeekend}}
   */
  function dayInfo(y, m, d, today) {
    today = today || new Date();
    var l = solar2lunar(y, m, d);
    var term = termOfDay(y, m, d);
    var fest = solarFestival(m, d) || lunarFestival(l);
    if (term === '清明') { fest = '清明'; }
    var hol = holidayOf(y, m, d);

    /* 小字优先级：节日 > 节气 > 农历 */
    var subType = 'lunar', subText = l.short;
    if (fest) { subType = 'festival'; subText = fest; }
    else if (term) { subType = 'term'; subText = term; }

    var wk = toDate(y, m, d).getDay();
    return {
      y: y, m: m, d: d, week: wk, weekCn: WEEK_CN[wk], weekEn: WEEK_EN[wk],
      lunar: l, term: term, festival: fest, holiday: hol,
      subText: subText, subType: subType,
      isToday: y === today.getFullYear() && m === today.getMonth() + 1 && d === today.getDate(),
      isWeekend: wk === 0 || wk === 6
    };
  }

  global.Lunar = {
    solar2lunar: solar2lunar,
    termOfDay: termOfDay,
    termsOfMonth: termsOfMonth,
    termDay: termDay,
    dayInfo: dayInfo,
    currentHoliday: currentHoliday,
    holidayOf: holidayOf,
    SOLAR_FESTIVAL: SOLAR_FESTIVAL,
    LUNAR_FESTIVAL: LUNAR_FESTIVAL,
    HOLIDAYS: HOLIDAYS,
    TERMS: TERMS,
    WEEK_CN: WEEK_CN,
    WEEK_EN: WEEK_EN
  };
})(window);
