/* ============================================================================
 * weather.js — 天气数据层（第二阶段）
 * ----------------------------------------------------------------------------
 * 双数据源，归一化成同一份结构给界面用：
 *   · open-meteo  —— 免费、免密钥、支持浏览器跨域，默认数据源
 *   · qweather    —— 和风天气，需自行填写 API Host 与 Key
 *
 * 职责：
 *   1. 取数（实时 + 预报 + 空气质量 + 日出日落 + 紫外线）
 *   2. 归一化（统一成 { city, cond, temp, feels, hi, lo, humidity, ... }）
 *   3. 缓存到 localStorage，失败时回退缓存并标注时间
 *   4. 城市搜索、自动定位
 *
 * 纯 fetch，无第三方库。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LS_CFG = 'dash.weather.cfg';
  var LS_CACHE = 'dash.weather.cache';

  /* ------------------------------------------------------------ 默认配置 */
  var DEFAULT_FIELDS = {
    feels: 1, hiLo: 1, humidity: 1, wind: 1, aqi: 1, uv: 1, sun: 1, forecast: 1
  };

  var DEFAULT_CFG = {
    provider: 'open-meteo',                                   /* 'open-meteo' | 'qweather' */
    host: '',                                                 /* 和风 API Host，如 https://xxx.re.qweatherapi.com */
    key: '',                                                  /* 和风 API Key */
    place: { name: '攀枝花', lat: 26.58509, lon: 101.71276, id: '101270101' },
    days: 3,                                                  /* 3 或 7 */
    refreshHours: 2,                                          /* 1 / 2 / 4 */
    autoLocate: 1,
    fields: DEFAULT_FIELDS
  };

  /* -------------------------------------------------- WMO 天气代码（Open-Meteo） */
  var WMO = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
    56: '冻毛毛雨', 57: '冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '阵雨', 81: '阵雨', 82: '强阵雨',
    85: '阵雪', 86: '阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
  };

  /* 风向文字（8 方位） */
  var DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

  /* 蒲福风级下限（km/h） */
  var BEAUFORT = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];

  /* ---------------------------------------------------------------- 工具 */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function windScale(kmh) {
    if (kmh == null) { return 0; }
    for (var i = BEAUFORT.length - 1; i >= 0; i--) { if (kmh >= BEAUFORT[i]) { return i + 1; } }
    return 0;
  }

  function windDir(deg) {
    if (deg == null) { return ''; }
    return DIRS[Math.round(deg / 45) % 8] + '风';
  }

  function uvText(uv) {
    if (uv == null) { return '--'; }
    if (uv <= 2) { return '弱'; }
    if (uv <= 5) { return '中'; }
    if (uv <= 7) { return '强'; }
    if (uv <= 10) { return '很强'; }
    return '极强';
  }

  function aqiText(aqi) {
    if (aqi == null) { return '--'; }
    if (aqi <= 50) { return '优'; }
    if (aqi <= 100) { return '良'; }
    if (aqi <= 150) { return '轻度污染'; }
    if (aqi <= 200) { return '中度污染'; }
    if (aqi <= 300) { return '重度污染'; }
    return '严重污染';
  }

  function iconOf(cond) {
    cond = cond || '';
    if (/雷/.test(cond)) { return 'thunder'; }
    if (/雪|冰雹|霰/.test(cond)) { return 'snow'; }
    if (/雨|毛毛/.test(cond)) { return 'rain'; }
    if (/雾|霾|沙|尘/.test(cond)) { return 'fog'; }
    if (/阴/.test(cond)) { return 'cloud'; }
    if (/多云|晴间/.test(cond)) { return 'sun-cloud'; }
    return 'sun';
  }

  function weekdayCn(dateStr) {
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }

  function hhmm(iso) {
    /* Open-Meteo 返回 "2026-10-06T07:12" */
    if (!iso) { return '--:--'; }
    var m = /T(\d{2}:\d{2})/.exec(iso);
    return m ? m[1] : String(iso).slice(-5);
  }

  /* 带超时的 JSON 请求 */
  function getJSON(url, timeout) {
    return new Promise(function (resolve, reject) {
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var done = false;
      var timer = setTimeout(function () {
        if (done) { return; }
        done = true;
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        reject(new Error('请求超时'));
      }, timeout || 12000);
      fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        return r.json();
      }).then(function (j) {
        if (done) { return; }
        done = true; clearTimeout(timer); resolve(j);
      }).catch(function (e) {
        if (done) { return; }
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  /* ------------------------------------------------------------ 配置读写 */
  var cfg = loadCfg();

  function loadCfg() {
    var c = {};
    try {
      var raw = localStorage.getItem(LS_CFG);
      if (raw) { c = JSON.parse(raw) || {}; }
    } catch (e) {}
    var out = {};
    for (var k in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) { out[k] = DEFAULT_CFG[k]; }
    }
    for (var k2 in c) {
      if (Object.prototype.hasOwnProperty.call(c, k2)) { out[k2] = c[k2]; }
    }
    out.fields = {};
    for (var f in DEFAULT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_FIELDS, f)) {
        out.fields[f] = (c.fields && c.fields[f] != null) ? (c.fields[f] ? 1 : 0) : DEFAULT_FIELDS[f];
      }
    }
    out.place = out.place || DEFAULT_CFG.place;
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

  /* -------------------------------------------------------------- 缓存 */
  function readCache() {
    try {
      var raw = localStorage.getItem(LS_CACHE);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeCache(data) {
    try { localStorage.setItem(LS_CACHE, JSON.stringify(data)); } catch (e) {}
  }

  /* ---------------------------------------------------- Open-Meteo 取数 */
  function openMeteoFetch() {
    var p = cfg.place;
    var days = cfg.days >= 7 ? 7 : 3;
    var fetchDays = Math.max(days, 5);   /* 至少取 5 天，深色折线图才有形状 */
    var base = 'https://api.open-meteo.com/v1/forecast?latitude=' + p.lat +
      '&longitude=' + p.lon +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max' +
      '&timezone=auto&forecast_days=' + (fetchDays + 1);

    var air = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + p.lat +
      '&longitude=' + p.lon + '&current=us_aqi,pm2_5&timezone=auto';

    return Promise.all([
      getJSON(base),
      getJSON(air).catch(function () { return null; })   /* 空气质量失败不影响主数据 */
    ]).then(function (res) {
      var j = res[0], a = res[1] || {};
      var cur = j.current || {}, d = j.daily || {};
      var times = d.time || [];
      var list = [];
      for (var i = 1; i < times.length && list.length < fetchDays; i++) {
        var cond = WMO[d.weather_code[i]] || '--';
        list.push({
          date: times[i],
          w: weekdayCn(times[i]),
          hi: Math.round(d.temperature_2m_max[i]),
          lo: Math.round(d.temperature_2m_min[i]),
          cond: cond,
          icon: iconOf(cond)
        });
      }
      var cond0 = WMO[cur.weather_code] || '--';
      var windKmh = cur.wind_speed_10m;
      var uv = (d.uv_index_max && d.uv_index_max[0] != null) ? d.uv_index_max[0] : null;
      var aqi = (a.current && a.current.us_aqi != null) ? a.current.us_aqi : null;

      return {
        city: p.name,
        cond: cond0,
        icon: iconOf(cond0),
        temp: Math.round(cur.temperature_2m),
        feels: Math.round(cur.apparent_temperature),
        hi: Math.round(d.temperature_2m_max[0]),
        lo: Math.round(d.temperature_2m_min[0]),
        humidity: Math.round(cur.relative_humidity_2m),
        humidityPct: clamp(Math.round(cur.relative_humidity_2m), 0, 100),
        windDir: windDir(cur.wind_direction_10m),
        windScale: windScale(windKmh) + '级',
        windPct: clamp(Math.round(windScale(windKmh) / 12 * 100), 4, 100),
        aqi: aqi,
        aqiText: aqiText(aqi),
        aqiPct: aqi == null ? 0 : clamp(Math.round(100 - aqi / 2), 6, 100),
        uv: uv,
        uvText: uvText(uv),
        uvPct: uv == null ? 0 : clamp(Math.round(uv / 11 * 100), 4, 100),
        sunrise: hhmm(d.sunrise && d.sunrise[0]),
        sunset: hhmm(d.sunset && d.sunset[0]),
        forecast: list,
        updatedAt: Date.now(),
        source: 'open-meteo',
        fromCache: false
      };
    });
  }

  /* ------------------------------------------------------- 和风天气取数 */
  function qweatherFetch() {
    if (!cfg.host || !cfg.key) {
      return Promise.reject(new Error('未填写和风 API Host 或 Key'));
    }
    var host = cfg.host.replace(/\/+$/, '');
    var loc = cfg.place.lat + ',' + cfg.place.lon;
    var days = cfg.days >= 7 ? 7 : 3;
    var q = '?location=' + encodeURIComponent(loc) + '&key=' + encodeURIComponent(cfg.key);

    return Promise.all([
      getJSON(host + '/v7/weather/now' + q),
      getJSON(host + '/v7/weather/' + days + 'd' + q),
      getJSON(host + '/v7/air/now' + q).catch(function () { return null; })
    ]).then(function (res) {
      var now = res[0].now || {};
      var daily = (res[1].daily || []);
      var air = (res[2] && res[2].now) || {};
      var list = daily.slice(1, days + 1).map(function (x) {
        return {
          date: x.fxDate,
          w: weekdayCn(x.fxDate),
          hi: Math.round(+x.tempMax),
          lo: Math.round(+x.tempMin),
          cond: x.textDay,
          icon: iconOf(x.textDay)
        };
      });
      var windKmh = Math.round((+now.windSpeed || 0) * 3.6);
      var uv = daily[0] ? +daily[0].uvIndex : null;
      var aqi = air.aqi != null ? +air.aqi : null;
      var scale = +now.windScale || 0;

      return {
        city: cfg.place.name,
        cond: now.text || '--',
        icon: iconOf(now.text),
        temp: Math.round(+now.temp),
        feels: Math.round(+now.feelsLike),
        hi: daily[0] ? Math.round(+daily[0].tempMax) : null,
        lo: daily[0] ? Math.round(+daily[0].tempMin) : null,
        humidity: Math.round(+now.humidity),
        humidityPct: clamp(Math.round(+now.humidity), 0, 100),
        windDir: now.windDir || windDir(+now.wind360),
        windScale: scale + '级',
        windPct: clamp(Math.round(scale / 12 * 100), 4, 100),
        aqi: aqi,
        aqiText: air.category || aqiText(aqi),
        aqiPct: aqi == null ? 0 : clamp(Math.round(100 - aqi / 2), 6, 100),
        uv: uv,
        uvText: uvText(uv),
        uvPct: uv == null ? 0 : clamp(Math.round(uv / 11 * 100), 4, 100),
        sunrise: daily[0] ? daily[0].sunrise : '--:--',
        sunset: daily[0] ? daily[0].sunset : '--:--',
        forecast: list,
        updatedAt: Date.now(),
        source: 'qweather',
        fromCache: false,
        _windKmh: windKmh
      };
    });
  }

  /* ---------------------------------------------------------- 内置兜底 */
  function fallbackData() {
    var base = new Date();
    var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    var hi = [27, 25, 24, 26, 28, 27];
    var lo = [15, 14, 13, 15, 16, 15];
    var list = [];
    for (var i = 0; i < Math.max(cfg.days, 3); i++) {
      var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i + 1);
      list.push({
        date: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
        w: WEEK[d.getDay()],
        hi: hi[i % 6], lo: lo[i % 6], cond: '晴', icon: 'sun'
      });
    }
    return {
      city: cfg.place.name, cond: '晴', icon: 'sun',
      temp: 26, feels: 28, hi: 28, lo: 17,
      humidity: 45, humidityPct: 45,
      windDir: '东南风', windScale: '3级', windPct: 38,
      aqi: null, aqiText: '--', aqiPct: 0,
      uv: null, uvText: '--', uvPct: 0,
      sunrise: '07:12', sunset: '18:44',
      forecast: list,
      updatedAt: 0, source: 'mock', fromCache: false
    };
  }

  /* -------------------------------------------------------------- 取数主入口 */
  function fetchNow() {
    return cfg.provider === 'qweather' ? qweatherFetch() : openMeteoFetch();
  }

  /**
   * 取天气数据。优先用未过期缓存；过期则请求；请求失败回退缓存；无缓存用内置兜底。
   * @param {{force?:boolean}} opt
   */
  function refresh(opt) {
    opt = opt || {};
    var cache = readCache();
    var ttl = Math.max(1, cfg.refreshHours) * 3600 * 1000;

    if (!opt.force && cache && cache.updatedAt && (Date.now() - cache.updatedAt) < ttl) {
      return Promise.resolve(shallow(cache, { fromCache: true, fresh: true }));
    }
    return fetchNow().then(function (data) {
      writeCache(data);
      return data;
    }).catch(function (err) {
      if (cache) {
        return shallow(cache, { fromCache: true, fresh: false, error: String(err.message || err) });
      }
      var fb = fallbackData();
      fb.error = String(err.message || err);
      return fb;
    });
  }

  function shallow(o, extra) {
    var r = {};
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { r[k] = o[k]; } }
    for (var k2 in extra) { if (Object.prototype.hasOwnProperty.call(extra, k2)) { r[k2] = extra[k2]; } }
    return r;
  }

  /* ---------------------------------------------------------- 城市搜索 */
  function searchCity(q) {
    q = String(q || '').trim();
    if (!q) { return Promise.resolve([]); }

    if (cfg.provider === 'qweather' && cfg.host && cfg.key) {
      var host = cfg.host.replace(/\/+$/, '');
      return getJSON(host + '/v2/city/lookup?location=' + encodeURIComponent(q) +
        '&key=' + encodeURIComponent(cfg.key) + '&number=8').then(function (j) {
        return (j.location || []).map(function (x) {
          return {
            name: x.name, id: x.id, lat: +x.lat, lon: +x.lon,
            admin: [x.adm1, x.adm2].filter(Boolean).join(' · '),
            country: x.country
          };
        });
      });
    }

    return getJSON('https://geocoding-api.open-meteo.com/v1/search?name=' +
      encodeURIComponent(q) + '&count=8&language=zh&format=json').then(function (j) {
      return (j.results || []).map(function (x) {
        return {
          name: x.name, id: '', lat: x.latitude, lon: x.longitude,
          admin: [x.admin1, x.admin2].filter(Boolean).join(' · '),
          country: x.country
        };
      });
    });
  }

  /* ---------------------------------------------------------- 自动定位 */
  function geolocate(timeout) {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error('设备不支持定位')); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
      }, function (e) {
        reject(new Error(e && e.code === 1 ? '定位权限被拒绝' : '定位失败'));
      }, { enableHighAccuracy: false, timeout: timeout || 9000, maximumAge: 600000 });
    });
  }

  /* 逆地理编码拿城市名（失败就退回"当前位置"） */
  function reverseName(lat, lon) {
    return getJSON('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat +
      '&longitude=' + lon + '&localityLanguage=zh', 8000).then(function (j) {
      return j.city || j.locality || j.principalSubdivision || '当前位置';
    }).catch(function () { return '当前位置'; });
  }

  /** 自动定位：成功则写入 place */
  function locateAndSave() {
    return geolocate().then(function (pos) {
      return reverseName(pos.lat, pos.lon).then(function (name) {
        cfg.place = { name: name, lat: +pos.lat.toFixed(5), lon: +pos.lon.toFixed(5), id: '' };
        saveCfg();
        return cfg.place;
      });
    });
  }

  /* ---------------------------------------------------------- 连接测试 */
  function testConnection() {
    var t0 = Date.now();
    return fetchNow().then(function (d) {
      return { ok: true, ms: Date.now() - t0, msg: d.city + ' ' + d.cond + ' ' + d.temp + '°C' };
    }).catch(function (e) {
      return { ok: false, ms: Date.now() - t0, msg: String(e.message || e) };
    });
  }

  /* -------------------------------------------------------------- 导出 */
  global.Weather = {
    cfg: cfg,
    defaults: DEFAULT_CFG,
    setCfg: setCfg,
    saveCfg: saveCfg,
    refresh: refresh,
    fetchNow: fetchNow,
    searchCity: searchCity,
    locateAndSave: locateAndSave,
    testConnection: testConnection,
    readCache: readCache,
    writeCache: writeCache,
    fallbackData: fallbackData,
    uvText: uvText,
    aqiText: aqiText,
    iconOf: iconOf
  };
})(window);
