/* ============================================================================
 * check-compat.js — 兼容性自检
 * ----------------------------------------------------------------------------
 * 目标设备：酷比魔方 iPlay 20 Pro
 *   系统 WebView = **Chrome 74**（2019-04，出厂版，用户升级失败）
 *   所以整个项目必须停在 Chrome 74 的能力范围内。
 *
 * 这个脚本扫 assets/ 下的全部 CSS / JS，把用超纲语法的地方连行号列出来，
 * 并给出替代写法。改动后跑一遍即可，不用靠脑子记。
 *
 * 用法：node 工具/检查兼容性.js     （或双击 工具/一键检查兼容性.cmd）
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = 'Chrome 74';

/* ------------------------------------------------------------------ 规则表 */

const CSS_RULES = [
  { re: /(^|[\s;{])inset\s*:/,          need: 87,  fix: 'top/right/bottom/left 分开写' },
  { re: /(^|[\s;{])(margin|padding)-(inline|block)(-start|-end)?\s*:/, need: 87, fix: '改用物理属性 margin-left / padding-top 等' },
  { re: /(^|[\s;{])inset-(inline|block)/, need: 87, fix: '改用物理属性' },
  { re: /:(is|where)\(/,                need: 88,  fix: '把选择器展开逐个写' },
  { re: /:has\(/,                       need: 105, fix: '用 JS 判断后加 class' },
  { re: /(^|[\s;{])aspect-ratio\s*:/,   need: 88,  fix: '用 padding-top 百分比撑高' },
  { re: /(^|[\s;{])color-mix\(/,        need: 111, fix: '预先算好颜色值' },
  { re: /(^|[\s;{])(min|max|clamp)\(/,  need: 79,  fix: '用固定值或 JS 计算' },
  { re: /(^|[\s;{])(translate|rotate|scale)\s*:/, need: 104, fix: '合进 transform' },
  { re: /(^|[\s;{])backdrop-filter\s*:/, need: 76, fix: '只能当锦上添花，必须有降级样式', soft: true },
  { re: /(^|[\s;{])accent-color\s*:/,   need: 93,  fix: '只是给复选框上色，忽略无害', soft: true },
  { re: /(^|[\s;{])scrollbar-width\s*:/, need: 121, fix: '改用 ::-webkit-scrollbar', soft: true },
];

const JS_RULES = [
  { re: /\?\./,                     need: 80,  fix: 'a && a.b && a.b.c' },
  { re: /\?\?/,                     need: 80,  fix: '显式判空' },
  { re: /(\|\||&&|\?\?)=/,          need: 85,  fix: '拆开写 a = a || b' },
  { re: /\.replaceAll\s*\(/,        need: 85,  fix: '.replace(/x/g, ...)' },
  { re: /Promise\.allSettled/,      need: 76,  fix: 'Promise.all + 各自 catch' },
  { re: /\.at\s*\(/,                need: 92,  fix: 'arr[arr.length - 1]' },
  { re: /Object\.hasOwn\s*\(/,      need: 93,  fix: 'Object.prototype.hasOwnProperty.call(obj, k)' },
  { re: /structuredClone\s*\(/,     need: 98,  fix: 'JSON.parse(JSON.stringify(x))' },
  { re: /\.findLast(Index)?\s*\(/,  need: 97,  fix: '手写倒序循环' },
  { re: /\bglobalThis\b/,           need: 71,  fix: 'window', soft: true },
];

/* --------------------------------------------------------------- 工具函数 */

function listFiles(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) { return out; }
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); }
      else if (name.endsWith(ext)) { out.push(p); }
    }
  })(dir);
  return out;
}

const relative = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/** 把注释抹成空白，避免把说明文字当代码扫 */
function blankComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 按「规则块」解析 CSS：返回每一块的 选择器 + 声明列表（含行号）。
 * 按块判断才准 —— 比如 .metric 是不是 grid，得看它自己的 display，不能看选择器名字。
 */
function parseCssRules(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = blankComments(raw).split('\n');
  const rules = [];
  let selector = '';
  let startLine = 1;
  let decls = [];

  const flush = () => {
    if (decls.length) { rules.push({ selector, decls, line: startLine }); decls = []; }
  };

  lines.forEach((line, i) => {
    const open = line.indexOf('{');
    const close = line.indexOf('}');
    if (open >= 0) {
      const sel = line.slice(0, open).trim();
      if (sel) { selector = sel; }
      startLine = i + 1;
      decls = [];
      const rest = line.slice(open + 1);
      if (rest.trim()) {
        if (rest.indexOf('}') >= 0) {
          rules.push({ selector, decls: [{ text: rest.split('}')[0], line: i + 1 }], line: startLine });
        } else {
          decls.push({ text: rest, line: i + 1 });
        }
      }
      return;
    }
    if (close >= 0) { flush(); return; }
    if (line.trim()) { decls.push({ text: line, line: i + 1 }); }
  });
  flush();
  return rules;
}

/* -------------------------------------------------------------- CSS 检查 */

function checkCss() {
  const problems = [];
  const gapRules = [];

  for (const file of listFiles(path.join(ROOT, 'assets', 'css'), '.css')) {
    if (path.basename(file) === 'legacy.css') { continue; }

    for (const rule of parseCssRules(file)) {
      const body = rule.decls.map((d) => d.text).join(';');
      const isGrid = /display\s*:\s*[^;]*grid/.test(body);

      for (const d of rule.decls) {
        for (const r of CSS_RULES) {
          if (r.re.test(d.text)) {
            problems.push({
              file: relative(file), line: d.line, text: d.text.trim(),
              need: r.need, fix: r.fix, soft: !!r.soft,
            });
          }
        }
      }

      // flex gap 单独看：**grid 的 gap 从 Chrome 57 就支持，不用管**
      if (!isGrid) {
        for (const d of rule.decls) {
          const m = d.text.match(/(^|[\s;{])gap\s*:\s*([^;]+)/);
          if (m) {
            const val = m[2].trim();
            // gap: 0 / 0px / 0 0 本来就没有间距，不用补
            if (/^0(px|%)?(\s+0(px|%)?)?$/.test(val)) { continue; }
            gapRules.push({ file: relative(file), line: d.line, selector: rule.selector, text: d.text.trim() });
          }
        }
      }
    }
  }
  return { problems, gapRules };
}

/** 某个 gap 选择器在 legacy.css 里有没有对应的 margin 补丁 */
function checkGapCoverage(gapRules) {
  const legacyPath = path.join(ROOT, 'assets', 'css', 'legacy.css');
  if (!fs.existsSync(legacyPath)) { return { missing: gapRules, total: 0 }; }

  const norm = (s) => s
    .replace(/\.no-flexgap/g, '')
    .replace(/\[data-theme="?(light|dark)"?\]/g, '')
    .replace(/\s*>\s*/g, ' > ')
    .replace(/\s+/g, ' ')
    .trim();

  // legacy.css 里所有「带 margin 的规则」的选择器
  const covered = [];
  for (const rule of parseCssRules(legacyPath)) {
    const body = rule.decls.map((d) => d.text).join(';');
    if (/margin/.test(body)) { covered.push(norm(rule.selector)); }
  }

  const missing = gapRules.filter((g) => {
    const sel = norm(g.selector);
    if (!sel) { return false; }
    return !covered.some((c) => c.indexOf(sel) >= 0);
  });
  return { missing, total: covered.length };
}

/* --------------------------------------------------------------- JS 检查 */

function checkJs() {
  const problems = [];
  for (const file of listFiles(path.join(ROOT, 'assets', 'js'), '.js')) {
    const raw = fs.readFileSync(file, 'utf8');
    const code = blankComments(raw).split('\n');
    const rawLines = raw.split('\n');
    code.forEach((line, i) => {
      // 整行注释跳过，少点误报
      if (/^\s*(\/\/|\*)/.test(rawLines[i] || '')) { return; }
      for (const rule of JS_RULES) {
        if (rule.re.test(line)) {
          problems.push({
            file: relative(file), line: i + 1,
            text: (rawLines[i] || '').trim(),
            need: rule.need, fix: rule.fix, soft: !!rule.soft,
          });
        }
      }
    });
  }
  return problems;
}

/* ------------------------------------------------------------------ 输出 */

console.log('');
console.log('  兼容性自检  ——  目标：' + TARGET + '（iPlay 20 Pro 的系统 WebView）');
console.log('  ══════════════════════════════════════════════════════════');

const css = checkCss();
const jsProblems = checkJs();
const gap = checkGapCoverage(css.gapRules);

function report(title, list) {
  if (!list.length) { console.log('\n  ' + title + '：✓ 干净'); return 0; }
  console.log('\n  ' + title + '：发现 ' + list.length + ' 处');
  for (const p of list) {
    console.log('    ' + (p.soft ? '○' : '✘') + ' ' + p.file + ':' + p.line + '  需要 Chrome ' + p.need);
    console.log('        ' + p.text);
    console.log('        → ' + p.fix);
  }
  return list.filter((p) => !p.soft).length;
}

const hardCss = report('CSS', css.problems);
const hardJs = report('JS', jsProblems);

if (!gap.missing.length) {
  console.log('\n  flex gap 补丁：✓ 全部覆盖（一共 ' + css.gapRules.length +
    ' 处 flex gap，legacy.css 里 ' + gap.total + ' 条补丁规则）');
} else {
  console.log('\n  flex gap 补丁：✘ 有 ' + gap.missing.length + ' 处没补');
  for (const g of gap.missing) {
    console.log('    ✘ ' + g.file + ':' + g.line + '  选择器 ' + (g.selector || '(未知)'));
    console.log('        ' + g.text);
    console.log('        → 到 assets/css/legacy.css 补一条 margin 规则');
  }
}

const total = hardCss + hardJs + gap.missing.length;
console.log('\n  ══════════════════════════════════════════════════════════');
if (total === 0) {
  console.log('  ✓ 全部通过，可以放心打包');
} else {
  console.log('  还有 ' + total + ' 处硬伤需要处理');
  console.log('  （○ 是"有降级、可接受"的软性问题）');
}
console.log('');
process.exitCode = total ? 1 : 0;
