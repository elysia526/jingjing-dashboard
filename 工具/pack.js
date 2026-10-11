/* ============================================================================
 * pack.js — 单文件打包器
 * ----------------------------------------------------------------------------
 * 把 index.html 里引用的 CSS / JS 原样复制、内嵌进 <style> / <script>，
 * 产出一个可以直接发给别人、双击就能打开的 HTML。
 *
 * 原则：只读源文件，不修改 assets/ 下任何 css、js。
 *
 * 用法：node 工具/pack.js      （或双击 工具/一键打包.cmd）
 * 产物：分享版/鲸鲸仪表板.html
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(ROOT, '分享版');
const OUT = path.join(OUT_DIR, '鲸鲸仪表板.html');

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { throw new Error('找不到文件：' + rel); }
  return fs.readFileSync(p, 'utf8');
}

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

const inlined = [];
let html = read('index.html');

/* ---- 内嵌 CSS ---- */
html = html.replace(
  /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
  function (m, href) {
    if (/^(https?:)?\/\//i.test(href)) { return m; }        /* 外链保持原样 */
    const css = read(href);
    inlined.push({ kind: 'CSS', file: href, bytes: Buffer.byteLength(css) });
    return '<style>\n/* ===== ' + href + ' ===== */\n' + css + '\n</style>';
  }
);

/* ---- 内嵌 JS ---- */
html = html.replace(
  /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
  function (m, src) {
    if (/^(https?:)?\/\//i.test(src)) { return m; }
    let js = read(src);
    /* 万一脚本里出现 </script 字样会提前闭合标签，转义掉 */
    js = js.replace(/<\/script/gi, '<\\/script');
    inlined.push({ kind: 'JS', file: src, bytes: Buffer.byteLength(js) });
    return '<script>\n/* ===== ' + src + ' ===== */\n' + js + '\n</script>';
  }
);

/* ---- 注入内置 API 预设（只有分享版有；源码 index.html 里没有） ---- */
const PRESET_FILE = path.join(__dirname, 'preset.json');
let presetNote = '不含内置 API';
let presetScript = '';
if (fs.existsSync(PRESET_FILE)) {
  try {
    const preset = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
    if (preset && preset.ai && preset.ai.key && preset.ai.baseUrl) {
      presetScript =
        '<script>\n' +
        '/* ===== 内置 API 预设（仅单文件分享版）=====\n' +
        '   这段只存在于打包产物里，源码 index.html 与 assets/ 下都不含它。 */\n' +
        'window.DASH_PRESET = ' + JSON.stringify({ ai: preset.ai }) + ';\n' +
        '</script>\n';
      presetNote = preset.ai.model + ' @ ' + preset.ai.baseUrl;
    }
  } catch (e) {
    console.error('  预设文件读取失败：' + e.message);
  }
}
if (presetScript) {
  html = html.replace('<body>', '<body>\n' + presetScript);
}

/* ---- 打上生成标记 ---- */
const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
html = html.replace(
  '<head>',
  '<head>\n<!-- 单文件分享版 · 由 工具/pack.js 于 ' + stamp + ' 生成 · 源文件未改动 -->'
);

/* ---- 自检：还有没有漏掉的外部资源引用 ---- */
const leftovers = [];
const refRe = /<(?:link|script|img)\b[^>]*\b(?:href|src)=["']([^"']+)["']/gi;
let mm;
while ((mm = refRe.exec(html)) !== null) {
  const u = mm[1];
  if (/^(https?:)?\/\//i.test(u) || /^data:/i.test(u) || /^#/.test(u)) { continue; }
  leftovers.push(u);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

/* ---- 报告 ---- */
const outBytes = Buffer.byteLength(html);
const lines = [];
lines.push('');
lines.push('  单文件打包完成');
lines.push('  ────────────────────────────────────────────');
inlined.forEach(function (x) {
  lines.push('    ' + x.kind.padEnd(3) + '  ' + x.file.padEnd(34) + kb(x.bytes).padStart(10));
});
lines.push('  ────────────────────────────────────────────');
lines.push('    内置预设  ' + presetNote);
lines.push('  ────────────────────────────────────────────');
lines.push('    产物  ' + path.relative(ROOT, OUT).padEnd(34) + kb(outBytes).padStart(10));
lines.push('');
if (leftovers.length) {
  lines.push('  ⚠ 仍有未内嵌的本地引用，分享出去可能缺东西：');
  leftovers.forEach(function (u) { lines.push('      ' + u); });
} else {
  lines.push('  ✓ 已确认没有遗留的本地资源引用，单文件可直接分享');
}
lines.push('');

console.log(lines.join('\n'));
