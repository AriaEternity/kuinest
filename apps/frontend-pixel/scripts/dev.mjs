// 仅监听回环。代理准确 Origin，拒绝其他来源；不记录正文、口令或 Cookie。
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { root, sharedSource } from './shared.mjs';
const port = Number(process.env.PORT || 5488);
const target = new URL(process.env.KUINEST_API_ORIGIN || 'http://127.0.0.1:4317');
const publicOrigin = new URL(process.env.KUINEST_PUBLIC_ORIGIN || target.origin).origin;
if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('KUINEST_API_ORIGIN 必须为无凭据的服务 origin');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    const path = requestUrl.pathname;
    const host = req.headers.host;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) { res.writeHead(403).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (path.startsWith('/api/v1/')) {
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) { res.writeHead(403).end(); return; }
      const headers = { ...req.headers, host: target.host };
      delete headers.connection; delete headers['proxy-authorization'];
      if (origin) headers.origin = publicOrigin;
      const proxy = (target.protocol === 'https:' ? https : http).request(new URL(path + requestUrl.search, target), { method: req.method, headers }, upstream => {
        const responseHeaders = { ...upstream.headers, 'cache-control': 'no-store' };
        delete responseHeaders.connection;
        res.writeHead(upstream.statusCode, responseHeaders); upstream.pipe(res);
        upstream.on('error', () => res.destroy());
      });
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'BACKEND_UNAVAILABLE', message: '无法连接聊天服务。' }, requestId: 'local-proxy' })); else res.destroy(); });
      req.on('aborted', () => proxy.destroy()); res.on('close', () => proxy.destroy());
      req.pipe(proxy); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    let data;
    if (path.startsWith('/shared/')) data = await sharedSource(path.slice('/shared'.length));
    else {
      const asset = decodeURIComponent(path === '/' ? '/index.html' : path);
      if (!/^\/(index\.html|(?:js|css|assets)\/[^\0]+)$/.test(asset)) { res.writeHead(404).end(); return; }
      const file = resolve(root, '.' + asset);
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      data = await readFile(file);
    }
    res.writeHead(200, { 'Content-Type': mime[extname(path === '/' ? '/index.html' : path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`像素桌面：http://127.0.0.1:${port}/ · 演示：?mode=demo · HTTP：?mode=http · 代理：${target.origin}`));
