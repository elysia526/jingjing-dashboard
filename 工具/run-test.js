/* ============================================================================
 * run-test.js — 无头浏览器测试跑板
 * ----------------------------------------------------------------------------
 * 为什么需要它：
 *   Chrome 的 --dump-dom / --screenshot 在**页面 load 事件之后**就抓取，
 *   而 IndexedDB 这类真正的异步 I/O 还没回调完就被拍下来了 ——
 *   于是"用 IndexedDB"的测试永远看到的是降级结果，测了个寂寞。
 *
 * 做法：
 *   1. 起一个极小的静态服务，把工程目录挂出去（http 源才能用 IndexedDB）
 *   2. 页面跑完测试后 POST /__result 回传文本
 *   3. 服务端打印结果并退出，页面再复杂也不怕拍早了
 *
 * 用法：node 工具/run-test.js <页面相对路径> [等待毫秒]
 *   例：node 工具/run-test.js 测试/背景自检.html 30000
 * ==========================================================================*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PAGE = process.argv[2] || '测试/背景自检.html';
const WAIT_MS = parseInt(process.argv[3] || '30000', 10);
const PORT = 8791 + Math.floor(Math.random() * 100);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};

let chrome = null;
let finished = false;

function done(code) {
  if (finished) { return; }
  finished = true;
  if (chrome) { try { chrome.kill(); } catch (e) {} }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 500);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__result') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      console.log(decodeURIComponent(body));
      done(0);
    });
    return;
  }
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  if (!CHROME) { console.error('找不到 Chrome / Edge'); done(1); return; }
  const url = 'http://127.0.0.1:' + PORT + '/' + PAGE.split('/').map(encodeURIComponent).join('/');
  console.log('  打开 ' + url);
  const profile = path.join(require('os').tmpdir(), 'wbtest-' + PORT);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile,
    '--window-size=1920,1200',
    url
  ], { stdio: 'ignore' });

  setTimeout(() => {
    if (!finished) { console.error('  超时：' + WAIT_MS + 'ms 内没有收到结果'); done(2); }
  }, WAIT_MS);
});
