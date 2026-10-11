/* ============================================================================
 * fluidize.js — 一次性把 CSS 里的固定 px 换成流体单位
 * ----------------------------------------------------------------------------
 * 目标：让 1920×1200 的设计稿在任何宽高比的横屏/方屏上都能**铺满**，
 *       而且元素比例不失真。
 *
 * 原理：
 *   app.js 在 :root 上写入 --u（无单位倍数）＝ min(视口宽/1920, 视口高/1200)
 *   CSS 里所有需要跟着缩放的尺寸写成 calc(N * var(--u))
 *   → 在 1920×1200 上 --u=1，结果与改造前**逐像素一致**
 *   → 在 16:9 上 --u 由高度决定，横向多出来的空间交给 grid 的 1fr 吸收
 *   → 在 4:3 上 --u 由宽度决定，纵向多出来的空间交给 grid 的行吸收
 *   这样永远铺满，且圆还是圆、字还是同样的比例。
 *
 * 不转换的：
 *   · 0            → 直接写 0
 *   · |值| <= 2px  → 发丝线（1px 边框等）保持物理细线，放大到 1.8px 反而糊
 *   · /* 注释 *\/ 里的文字 → 免得把说明文档改烂
 *   · url(...) 里的内容（SVG data URI 里有 viewBox="0 0 16 16" 之类）
 *
 * 用法：node 工具/fluidize.js
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  'assets/css/base.css',
  'assets/css/theme-light.css',
  'assets/css/theme-dark.css'
];

const HAIRLINE_MAX = 2;   /* 这个值以内的 px 保持物理尺寸 */

/** 把一段（不含注释的）CSS 文本里的 px 转成 calc(N * var(--u)) */
function convertSegment(seg) {
  return seg.replace(/(-?\d+(?:\.\d+)?)px/g, (whole, numStr, offset) => {
    // url(...) 里不要动
    const before = seg.slice(0, offset);
    const open = before.lastIndexOf('url(');
    const close = before.lastIndexOf(')');
    if (open > close) return whole;

    const n = parseFloat(numStr);
    if (n === 0) return '0';
    if (Math.abs(n) <= HAIRLINE_MAX) return whole;
    return 'calc(' + numStr + ' * var(--u))';
  });
}

/** 注释段落原样保留，只转换非注释部分 */
function convert(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('/*', i);
    if (start < 0) { out += convertSegment(text.slice(i)); break; }
    out += convertSegment(text.slice(i, start));
    const end = text.indexOf('*/', start + 2);
    if (end < 0) { out += text.slice(start); break; }
    out += text.slice(start, end + 2);          /* 注释整段原样保留 */
    i = end + 2;
  }
  return out;
}

let total = 0;
for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  const src = fs.readFileSync(file, 'utf8');
  const dst = convert(src);
  const n = (src.match(/(-?\d+(?:\.\d+)?)px/g) || []).length -
            (dst.match(/(-?\d+(?:\.\d+)?)px/g) || []).length;
  fs.writeFileSync(file, dst, 'utf8');
  total += n;
  console.log('  ' + rel.padEnd(28) + ' 转换 ' + n + ' 处');
}
console.log('\n  合计转换 ' + total + ' 处固定 px');
