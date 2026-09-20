/**
 * Tiny static file server for the offline fixtures and for manual use of the
 * extension. Zero dependencies — `node:http` only.
 *
 * Why a server at all: `content_scripts` cannot match `file://` URLs unless the
 * user ticks "Allow access to file URLs", so loading the fixtures over
 * http://localhost is the path that works without extra setup.
 *
 * Usage:  node tools/serve.js [port] [rootDir]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.EZR_PORT || 8788);
const root = path.resolve(process.argv[3] || path.join(ROOT, 'fixtures'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const INDEX = `<!doctype html><meta charset="utf-8"><title>EZ-Reader fixtures</title>
<h1>EZ-Reader fixtures</h1><p>本地静态目录: <code>${root}</code></p>
<ul id="list"></ul>
<script>
fetch('./_list.json').then(r=>r.json()).then(names=>{
  document.getElementById('list').innerHTML = names.map(n=>'<li><a href="./'+n+'">'+n+'</a></li>').join('');
}).catch(()=>{});
</script>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    const rel = decodeURIComponent(url.pathname);
    const target = path.join(root, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));

    // Never serve outside the root, even if the URL tries to escape.
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    if (url.pathname === '/_list.json') {
      const { readdir } = await import('node:fs/promises');
      const names = (await readdir(root)).filter((n) => n.endsWith('.html') || n.endsWith('.json'));
      res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(names));
      return;
    }

    let info = null;
    try {
      info = await stat(target);
    } catch {
      info = null;
    }

    if (!info || !info.isFile()) {
      if (rel === '/' || rel === '') {
        res.writeHead(200, { 'content-type': MIME['.html'] }).end(INDEX);
        return;
      }
      res.writeHead(404, { 'content-type': MIME['.txt'] }).end(`404 ${rel}`);
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      // Fixtures are static; forbid caching so edits show up immediately.
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { 'content-type': MIME['.txt'] }).end(`500 ${String(error && error.message)}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[serve] http://localhost:${port}/  →  ${root}`);
  console.log('[serve] 按 Ctrl+C 结束');
});

server.on('error', (error) => {
  console.error(`[serve] 启动失败: ${error.message}`);
  process.exitCode = 1;
});
