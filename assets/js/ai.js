/* ============================================================================
 * ai.js — AI 问候语与多轮对话（第五阶段）
 * ----------------------------------------------------------------------------
 * · 接口统一走 OpenAI Chat Completions 格式，可接任意兼容服务
 *   （DeepSeek / 智谱 / 月之暗面 / 本地 Ollama 等）
 * · 支持 SSE 流式逐字输出
 * · 每次请求都注入当前仪表板上下文（时间、农历、节气、假期、天气、电量…）
 * · 系统提示词可编辑，并支持 {{time}} {{weather}} 这类变量占位
 * · 生成失败时保留上一次成功的内容；从未成功过则交给界面走本地降级文案
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LS_CFG = 'dash.ai.cfg';
  var LS_GREET = 'dash.ai.greet';     /* 最近一次成功的问候语 */
  var LS_CHAT = 'dash.ai.chat';       /* 对话历史 */

  /* 问候语提示词 */
  var DEFAULT_PROMPT =
    '你是这台平板仪表板的问候助手。请用一到两句话向主人问好，语气自然、温和、不啰嗦，' +
    '可以顺带一句天气提醒或节日祝福。不要使用 Markdown 语法，不要堆砌表情符号。';

  /* 对话提示词。原来是硬编码在 ask() 里的，现在挪出来可编辑 ——
     「对话提示词」本来就应该和「问候语提示词」分开，两件事的语气要求不一样。 */
  var DEFAULT_CHAT_PROMPT =
    '你是这台平板仪表板的对话助手，回答简洁、口语化、直接给结论。' +
    '你可以参考下面的实时信息回答与时间、天气、日程相关的问题。';

  /* 打包器可以注入 window.DASH_PRESET.ai 作为内置默认值（分享版专用）。
     源码里不含任何 Key；没有注入时下面全部走空默认值。 */
  var PRESET = (global.DASH_PRESET && global.DASH_PRESET.ai) || {};
  var hasPreset = !!(PRESET.baseUrl && PRESET.key);
  function pv(k, d) {
    var v = PRESET[k];
    return (v === undefined || v === null || v === '') ? d : v;
  }

  var DEFAULT_CFG = {
    enabled: pv('enabled', 0),
    baseUrl: pv('baseUrl', ''),
    key: pv('key', ''),
    model: pv('model', ''),
    temperature: pv('temperature', 1.1),
    maxTokens: pv('maxTokens', 220),
    stream: 1,
    prompt: DEFAULT_PROMPT,
    chatPrompt: DEFAULT_CHAT_PROMPT,
    personaOn: 0,              /* 人设默认**关闭**，要用户自己去设置里打开 */
    personaId: '',             /* 默认不选任何一个人设 */
    greetMode: pv('greetMode', 'interval'),  /* manual | hourly | interval | morning */
    greetHours: pv('greetHours', 6),
    historyLimit: pv('historyLimit', 12),
    timeoutSec: 45
  };

  var cfg = loadCfg();
  var ctxProvider = function () { return {}; };
  var chatHistory = loadChat();

  /* ------------------------------------------------------------ 人设库 */
  var LS_PERSONA = 'dash.ai.personas';
  var LS_PERSONA_SEED = 'dash.ai.personaSeeded';

  function loadPersonas() {
    var a = [];
    try { a = JSON.parse(localStorage.getItem(LS_PERSONA) || '[]') || []; } catch (e) {}
    if (!Array.isArray(a)) { a = []; }
    return a.filter(function (p) { return p && p.id && typeof p.prompt === 'string'; });
  }
  function savePersonas() {
    try { localStorage.setItem(LS_PERSONA, JSON.stringify(personas)); } catch (e) {}
  }

  var personas = loadPersonas();

  /**
   * 首次启动把随应用分发的内置人设写进人设库。
   * 之后它们和用户自建的人设**完全一样**：能改能删，删了不会再回来
   * （dash.ai.personaSeeded 记着已种过的 id）。
   */
  function seedPersonas() {
    var list = global.DASH_BUILTIN_PERSONAS || [];
    if (!list.length) { return 0; }
    var done = {};
    try { done = JSON.parse(localStorage.getItem(LS_PERSONA_SEED) || '{}') || {}; } catch (e) {}
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.id || done[b.id]) { continue; }
      var exists = personas.some(function (p) { return p.id === b.id; });
      if (!exists) {
        personas.push({
          id: b.id, name: b.name || '内置人设',
          prompt: b.prompt || '', builtin: 1, createdAt: Date.now()
        });
        added++;
      }
      done[b.id] = 1;
    }
    try { localStorage.setItem(LS_PERSONA_SEED, JSON.stringify(done)); } catch (e) {}
    if (added) { savePersonas(); }
    return added;
  }

  function personaById(id) {
    for (var i = 0; i < personas.length; i++) { if (personas[i].id === id) { return personas[i]; } }
    return null;
  }
  function newPersonaId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }
  function addPersona(name, prompt) {
    var p = {
      id: newPersonaId(),
      name: String(name || '新人设').slice(0, 16),
      prompt: String(prompt || ''),
      createdAt: Date.now()
    };
    personas.push(p);
    savePersonas();
    return p.id;
  }
  function updatePersona(id, patch) {
    var p = personaById(id);
    if (!p) { return false; }
    if (patch.name !== undefined) { p.name = String(patch.name).slice(0, 16); }
    if (patch.prompt !== undefined) { p.prompt = String(patch.prompt); }
    savePersonas();
    return true;
  }
  function removePersona(id) {
    var n = personas.length;
    personas = personas.filter(function (p) { return p.id !== id; });
    if (personas.length === n) { return false; }
    savePersonas();
    if (cfg.personaId === id) { setCfg({ personaId: '', personaOn: 0 }); }
    return true;
  }

  /** 当前生效的人设（没开或没选就是 null） */
  function activePersona() {
    if (!cfg.personaOn || !cfg.personaId) { return null; }
    return personaById(cfg.personaId);
  }

  /** 拼进系统提示词的那一段。没启用人设就返回空串 */
  function personaBlock() {
    var p = activePersona();
    if (!p || !p.prompt) { return ''; }
    return '\n\n【人设：' + p.name + '】\n' + p.prompt;
  }

  /* ---------------------------------------------------------------- 存储 */
  function loadCfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(LS_CFG) || '{}') || {}; } catch (e) {}
    var out = {};
    for (var k in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) {
        /* 空字符串按"没设过"处理：这样分享版里清空地址会自动回到内置预设 */
        out[k] = (c[k] === undefined || c[k] === null || c[k] === '') ? DEFAULT_CFG[k] : c[k];
      }
    }
    if (!out.prompt) { out.prompt = DEFAULT_PROMPT; }
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

  function loadChat() {
    try { return JSON.parse(localStorage.getItem(LS_CHAT) || '[]') || []; } catch (e) { return []; }
  }

  function saveChat() {
    if (chatHistory.length > 60) { chatHistory = chatHistory.slice(-60); }
    try { localStorage.setItem(LS_CHAT, JSON.stringify(chatHistory)); } catch (e) {}
  }

  function getGreeting() {
    try { return JSON.parse(localStorage.getItem(LS_GREET) || 'null'); } catch (e) { return null; }
  }

  function saveGreeting(text) {
    try { localStorage.setItem(LS_GREET, JSON.stringify({ text: text, at: Date.now() })); } catch (e) {}
  }

  /* ------------------------------------------------------------ 上下文 */
  function setContextProvider(fn) { if (typeof fn === 'function') { ctxProvider = fn; } }

  function buildContext() {
    var s = {};
    try { s = ctxProvider() || {}; } catch (e) { s = {}; }
    var w = s.weather || {};

    var lines = [];
    lines.push('时间：' + (s.time || '--') + (s.period ? '（' + s.period + '）' : ''));
    lines.push('日期：' + (s.date || '--') + ' ' + (s.week || '') + '，' + (s.lunar || ''));
    if (s.term) { lines.push('节气：' + s.term); }
    if (s.festival) { lines.push('节日：' + s.festival); }
    if (s.holiday) { lines.push('假期：' + s.holiday); }

    var wx = [];
    if (w.city) { wx.push('城市 ' + w.city); }
    if (w.cond) { wx.push('天气 ' + w.cond); }
    if (w.temp != null) { wx.push('气温 ' + w.temp + '°C'); }
    if (w.feels != null) { wx.push('体感 ' + w.feels + '°C'); }
    if (w.hi != null && w.lo != null) { wx.push('今日 ' + w.hi + '°/' + w.lo + '°'); }
    if (w.humidity != null) { wx.push('湿度 ' + w.humidity + '%'); }
    if (w.windScale) { wx.push('风 ' + (w.windDir || '') + w.windScale); }
    if (w.aqiText) { wx.push('空气 ' + w.aqiText); }
    if (w.uvText) { wx.push('紫外线 ' + w.uvText); }
    if (w.sunrise && w.sunset) { wx.push('日出 ' + w.sunrise + ' 日落 ' + w.sunset); }
    if (wx.length) { lines.push('天气：' + wx.join('，')); }
    if (s.forecast) { lines.push('未来：' + s.forecast); }

    if (s.battery) { lines.push('电量：' + s.battery); }
    if (s.net) { lines.push('网络：' + s.net); }

    return {
      block: '【当前仪表板信息】\n' + lines.join('\n'),
      vars: {
        time: s.time || '',
        period: s.period || '',
        date: s.date || '',
        week: s.week || '',
        lunar: s.lunar || '',
        term: s.term || '',
        festival: s.festival || '',
        holiday: s.holiday || '',
        city: w.city || '',
        weather: w.cond || '',
        temp: (w.temp == null ? '' : w.temp + '°C'),
        feels: (w.feels == null ? '' : w.feels + '°C'),
        humidity: (w.humidity == null ? '' : w.humidity + '%'),
        battery: s.battery || '',
        net: s.net || ''
      }
    };
  }

  function substitute(tpl, vars) {
    return String(tpl || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, function (m, key) {
      return (vars[key] !== undefined && vars[key] !== null) ? String(vars[key]) : m;
    });
  }

  /* ------------------------------------------------------------ 请求 */
  function resolveUrl(base) {
    var u = String(base || '').trim().replace(/\/+$/, '');
    if (!u) { return ''; }
    if (/\/chat\/completions$/.test(u)) { return u; }
    return u + '/chat/completions';
  }

  function cleanText(s) {
    return String(s == null ? '' : s)
      .replace(/^\s*["'“”『「]+|["'“”』」]+\s*$/g, '')
      .replace(/^\s*(问候语|回答|回复)[:：]\s*/g, '')
      .trim()
      .slice(0, 400);
  }

  /**
   * @param {Array} messages OpenAI 格式消息数组
   * @param {Function} [onDelta] 传入则按流式逐字回调
   * @returns {Promise<string>}
   */
  function chat(messages, onDelta) {
    var url = resolveUrl(cfg.baseUrl);
    if (!url) { return Promise.reject(new Error('未填写 API 地址')); }
    if (!cfg.key) { return Promise.reject(new Error('未填写 API Key')); }
    if (!cfg.model) { return Promise.reject(new Error('未填写模型名称')); }

    var useStream = !!cfg.stream && typeof onDelta === 'function';
    var payload = {
      model: cfg.model,
      messages: messages,
      temperature: Math.max(0, Math.min(2, +cfg.temperature || 1)),
      max_tokens: Math.max(16, Math.min(8192, +cfg.maxTokens || 220)),
      stream: useStream
    };

    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) { try { ctl.abort(); } catch (e) {} } },
      Math.max(5, +cfg.timeoutSec || 45) * 1000);

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
      body: JSON.stringify(payload),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var msg = 'HTTP ' + r.status;
          try {
            var j = JSON.parse(t);
            msg += ' · ' + ((j.error && (j.error.message || j.error.type)) || j.message || t.slice(0, 120));
          } catch (e) { msg += ' · ' + String(t).slice(0, 120); }
          throw new Error(msg);
        });
      }
      if (!useStream) {
        return r.json().then(function (j) {
          var m = j.choices && j.choices[0] && j.choices[0].message;
          return cleanText(m && m.content);
        });
      }
      /* ---- SSE 流式 ---- */
      var reader = r.body.getReader();
      var dec = new TextDecoder('utf-8');
      var buf = '', full = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) { return full; }
          buf += dec.decode(res.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.indexOf('data:') !== 0) { continue; }
            var data = line.slice(5).trim();
            if (data === '[DONE]') { continue; }
            try {
              var j = JSON.parse(data);
              var d = j.choices && j.choices[0] &&
                (j.choices[0].delta || j.choices[0].message);
              if (d && d.content) { full += d.content; onDelta(d.content, full); }
            } catch (e) { /* 忽略半截 JSON */ }
          }
          return pump();
        });
      }
      return pump();
    }).then(function (text) {
      clearTimeout(timer);
      return typeof text === 'string' ? cleanText(text) : '';
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') { throw new Error('请求超时或被中断'); }
      throw e;
    });
  }

  /* -------------------------------------------------------- 问候语生成 */
  function greetSystemPrompt() {
    var ctx = buildContext();
    /* 人设夹在"基础提示词"和"实时上下文"之间：前面是任务要求，后面是数据，
       人设只负责语气，塞在中间最不容易被上下文淹掉 */
    return substitute(cfg.prompt, ctx.vars) + personaBlock() + '\n\n' + ctx.block;
  }

  function chatSystemPrompt() {
    var ctx = buildContext();
    return substitute(cfg.chatPrompt, ctx.vars) + personaBlock() + '\n\n' + ctx.block;
  }

  /**
   * 生成一条问候语。成功会写入缓存；失败抛错，由界面决定用缓存还是本地兜底。
   * @param {Function} [onDelta]
   */
  function greet(onDelta) {
    var msgs = [
      { role: 'system', content: greetSystemPrompt() },
      { role: 'user', content: '请生成此刻的问候语，只输出问候语本身，不要加引号或前缀。' }
    ];
    return chat(msgs, onDelta).then(function (t) {
      if (!t) { throw new Error('模型返回了空内容'); }
      saveGreeting(t);
      return t;
    });
  }

  /** 该不该重新生成问候语 */
  function shouldRefreshGreeting() {
    var cache = getGreeting();
    if (!cache || !cache.at) { return true; }
    var now = new Date();
    var c = cfg;
    if (c.greetMode === 'manual') { return false; }
    if (c.greetMode === 'hourly') {
      var a = new Date(cache.at);
      return a.getFullYear() !== now.getFullYear() || a.getMonth() !== now.getMonth() ||
        a.getDate() !== now.getDate() || a.getHours() !== now.getHours();
    }
    if (c.greetMode === 'morning') {
      var five = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 5, 0, 0).getTime();
      if (now.getTime() < five) { return false; }     /* 凌晨不算"今天早晨" */
      return cache.at < five;
    }
    return (Date.now() - cache.at) > Math.max(1, +c.greetHours || 6) * 3600 * 1000;
  }

  function nextGreetDelayMs() {
    var c = cfg;
    if (c.greetMode === 'hourly') {
      var now = new Date();
      var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 30);
      return Math.max(60000, next.getTime() - now.getTime());
    }
    if (c.greetMode === 'morning') {
      var n = new Date();
      var five = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 5, 0, 30);
      if (five.getTime() <= n.getTime()) { five = new Date(five.getTime() + 86400000); }
      return five.getTime() - n.getTime();
    }
    if (c.greetMode === 'manual') { return 0; }
    return Math.max(1, +c.greetHours || 6) * 3600 * 1000;
  }

  /* ---------------------------------------------------------------- 对话 */
  function history() { return chatHistory.slice(); }

  function pushHistory(role, content) {
    chatHistory.push({ role: role, content: content, at: Date.now() });
    /* 只保留最近 N 轮（一问一答算两条） */
    var limit = Math.max(2, +cfg.historyLimit || 12);
    while (chatHistory.length > limit) { chatHistory.shift(); }
    saveChat();
  }

  function clearHistory() {
    chatHistory = [];
    saveChat();
  }

  /** 多轮对话：永远携带当前上下文 + 最近历史 */
  function ask(userText, onDelta) {
    var msgs = [{ role: 'system', content: chatSystemPrompt() }];
    for (var i = 0; i < chatHistory.length; i++) {
      msgs.push({ role: chatHistory[i].role, content: chatHistory[i].content });
    }
    msgs.push({ role: 'user', content: userText });
    return chat(msgs, onDelta);
  }

  /* ------------------------------------------------------------ 连接测试 */
  function test() {
    var t0 = Date.now();
    var ctx = buildContext();
    return chat([
      { role: 'system', content: '你是连通性测试助手。' },
      { role: 'user', content: '只回复两个字：正常。\n（参考信息：' + ctx.vars.time + '）' }
    ]).then(function (t) {
      return { ok: true, ms: Date.now() - t0, msg: t || '(空回复)' };
    }).catch(function (e) {
      return { ok: false, ms: Date.now() - t0, msg: (e && e.message) || String(e) };
    });
  }

  global.AI = {
    cfg: cfg,
    defaults: DEFAULT_CFG,
    defaultPrompt: DEFAULT_PROMPT,
    defaultChatPrompt: DEFAULT_CHAT_PROMPT,
    /* 人设 */
    personas: function () { return personas.slice(); },
    personaById: personaById,
    activePersona: activePersona,
    seedPersonas: seedPersonas,
    addPersona: addPersona,
    updatePersona: updatePersona,
    removePersona: removePersona,
    chatSystemPrompt: chatSystemPrompt,
    greetSystemPrompt: greetSystemPrompt,
    hasPreset: hasPreset,
    preset: PRESET,
    setCfg: setCfg,
    saveCfg: saveCfg,
    setContextProvider: setContextProvider,
    buildContext: buildContext,
    resolveUrl: resolveUrl,
    chat: chat,
    greet: greet,
    getGreeting: getGreeting,
    saveGreeting: saveGreeting,
    shouldRefreshGreeting: shouldRefreshGreeting,
    nextGreetDelayMs: nextGreetDelayMs,
    history: history,
    pushHistory: pushHistory,
    clearHistory: clearHistory,
    ask: ask,
    test: test
  };
})(window);
