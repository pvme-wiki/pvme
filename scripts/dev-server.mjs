// Local preview only. It deliberately uses the actual unconfigured API handler;
// no demo identity or simulated cloud-save state is exposed through /edit/.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../server/http.mjs';
import { loadConfig } from '../server/config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const port = Number(args.includes('--port') ? option('--port') : process.env.PORT || 4173);
const handler = createHandler({ config: loadConfig({}) });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/__qa/mobile') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local mobile layout check</title><style>body{margin:0;background:#101a16;font:14px sans-serif;color:#d4ddcc}p{margin:14px}iframe{width:390px;height:844px;border:1px solid #50604f;display:block;margin:0 14px 14px}</style><p>Local test only · 390 × 844 editor viewport</p><iframe title="Mobile editor preview" src="/edit/"></iframe>'); return;
    }
    if (url.pathname.startsWith('/api/editor')) {
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : request;
      const result = await handler(new Request(url, { method: request.method, headers: request.headers, ...(body ? { body, duplex: 'half' } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer())); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const filename = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!filename.startsWith(root + path.sep) && filename !== root) { response.writeHead(403); response.end(); return; }
    let target = filename;
    if ((await fs.stat(target)).isDirectory()) {
      if (!url.pathname.endsWith('/')) { response.writeHead(302, { Location: url.pathname + '/' + url.search }); response.end(); return; }
      target = path.join(target, 'index.html');
    }
    const bytes = await fs.readFile(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404); response.end('Not found'); }
}).listen(port, '0.0.0.0', () => console.log(`Local PvME preview listening on ${port}; hosted accounts are unconfigured.`));
