/* ============================================================================
 * native.js — Android 壳的桥接适配层（第四阶段）
 * ----------------------------------------------------------------------------
 * 壳里通过 addJavascriptInterface 暴露了 window.NativeShell。
 * 这里把它的 JSON 字符串统一解析成对象，并做**彻底降级**：
 * 不在壳里（普通浏览器打开）时 Native.available === false，
 * 所有方法返回 null / false，网页其余部分完全不受影响。
 *
 * 设计原则：这一层只负责"能不能拿到"，不负责"拿不到怎么办"——
 * 降级由 app.js 判断，这样同一份网页在浏览器和 APK 里都能跑。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var SHELL = global.NativeShell || null;

  /** 调用无返回值的方法 */
  function call(name, arg) {
    if (!SHELL || typeof SHELL[name] !== 'function') { return false; }
    try {
      SHELL[name](arg);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 调用返回 JSON 字符串的方法 */
  function json(name) {
    if (!SHELL || typeof SHELL[name] !== 'function') { return null; }
    try {
      var raw = SHELL[name]();
      if (typeof raw !== 'string' || !raw) { return null; }
      var o = JSON.parse(raw);
      if (!o || o.ok === false) { return null; }
      return o;
    } catch (e) {
      return null;
    }
  }

  /** 调用返回 boolean 的方法 */
  function bool(name) {
    if (!SHELL || typeof SHELL[name] !== 'function') { return null; }
    try {
      return !!SHELL[name]();
    } catch (e) {
      return null;
    }
  }

  global.Native = {
    available: !!SHELL,

    /** {level, charging, full, temperature, voltage} */
    battery: function () { return json('battery'); },
    /** {model, manufacturer, brand, android, sdk} */
    device: function () { return json('device'); },
    /** {totalBytes, freeBytes, usedBytes, usedPercent, totalGB, freeGB} */
    storage: function () { return json('storage'); },
    /** {online, type, ssid} */
    network: function () { return json('network'); },
    /** {packageName, versionName, versionCode} */
    appInfo: function () { return json('appInfo'); },

    getKeepScreenOn: function () { return bool('getKeepScreenOn'); },
    setKeepScreenOn: function (on) { return call('setKeepScreenOn', !!on); },

    setFullscreen: function (on) { return call('setFullscreen', !!on); },

    getAutoStart: function () { return bool('getAutoStart'); },
    setAutoStart: function (on) { return call('setAutoStart', !!on); },

    toast: function (msg) { return call('toast', String(msg == null ? '' : msg)); },
    vibrate: function (ms) { return call('vibrate', ms || 30); },
    restart: function () { return call('restart'); },

    /**
     * 告诉壳"网页跑起来了"。
     *
     * ⚠ 这里刻意**不走 call()**：call() 永远会传一个参数，
     *   而 Java 端 pageReady() 是无参方法。Android 的 JS 桥按
     *   「方法名 + 参数个数」匹配，个数对不上就静默失败 ——
     *   这个坑让页面上线后一直卡在"检测没过"。无参方法就老老实实无参调用。
     */
    pageReady: function () {
      if (!SHELL || typeof SHELL.pageReady !== 'function') { return false; }
      try { SHELL.pageReady(); return true; } catch (e) { return false; }
    },
    /** 把网页侧的报错递给壳，方便在诊断页里看到 */
    reportError: function (msg) { return call('reportError', String(msg == null ? '' : msg)); }
  };
})(window);
