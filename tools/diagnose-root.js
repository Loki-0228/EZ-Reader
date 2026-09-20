/**
 * Throwaway: inspect the candidate scoring for a fixture to explain a bad root choice.
 *
 * Usage: node tools/diagnose-root.js long.html
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const PROFILE = path.join(ROOT, 'test-artifacts', 'diag-root');
const PORT_HTTP = 8788;
const PORT_CDP = 9341;
const fixture = process.argv[2] || 'long.html';
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

await rm(PROFILE, { recursive: true, force: true });
await mkdir(PROFILE, { recursive: true });

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || fixture;
  try {
    const body = await readFile(path.join(ROOT, 'fixtures', rel));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('nope');
  }
});
await new Promise((r) => server.listen(PORT_HTTP, '127.0.0.1', r));

const child = spawn(
  BROWSER,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT_CDP}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-crash-reporter',
    `--load-extension=${DIST}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);

try {
  const version = await waitForEndpoint(PORT_CDP, { timeoutMs: 45000 });
  const session = await CdpSession.connect({ url: version.webSocketDebuggerUrl, port: PORT_CDP });
  const page = await CdpPage.attach(session, { url: `http://localhost:${PORT_HTTP}/${fixture}` });
  await page.setViewport(1280, 900);
  await page.goto(`http://localhost:${PORT_HTTP}/${fixture}`, { timeoutMs: 30000 });

  const contextId = await page.findContext('typeof window.__ezr === "object"', { timeoutMs: 25000 });
  if (contextId === null) {
    console.log('content script not found');
    process.exit(0);
  }
  const iso = (e) => page.evaluate(e, { contextId });

  console.log('probe:', await iso('JSON.stringify(window.__ezr.probe(), null, 1)'));

  // Recompute the candidate stats the selector sees, in the page, to explain the choice.
  console.log(
    '\n=== candidate containers (document order) ===\n' +
      (await iso(`(function () {
        var out = [];
        var nodes = document.querySelectorAll('main, article, [role=main], section, div');
        function paraStats(el) {
          var paras = el.querySelectorAll('p, li, blockquote, pre, td');
          var textLength = 0, linkLength = 0;
          for (var i = 0; i < paras.length; i++) {
            var t = paras[i].textContent || '';
            textLength += t.length;
            var links = paras[i].querySelectorAll('a');
            for (var j = 0; j < links.length; j++) linkLength += (links[j].textContent || '').length;
          }
          return { paras: paras.length, textLength: textLength, linkLength: linkLength };
        }
        for (var k = 0; k < nodes.length && out.length < 12; k++) {
          var el = nodes[k];
          var s = paraStats(el);
          var direct = el.children ? el.children.length : 0;
          out.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
            directChildren: direct,
            descendantParas: s.paras,
            textLength: s.textLength,
            linkRatio: s.textLength ? +(s.linkLength / s.textLength).toFixed(3) : 0
          });
        }
        return JSON.stringify(out, null, 1);
      })()`)),
  );

  console.log('\n=== body/first-level structure ===');
  console.log(
    await iso(`(function () {
      function describe(el, depth) {
        if (!el || depth > 3) return null;
        var kids = Array.prototype.slice.call(el.children || []).slice(0, 6).map(function (k) {
          return describe(k, depth + 1);
        }).filter(Boolean);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          innerParas: el.querySelectorAll ? el.querySelectorAll('p').length : 0,
          kids: kids
        };
      }
      return JSON.stringify(describe(document.body, 0), null, 1);
    })()`),
  );

  session.close();
} catch (error) {
  console.error('diagnose failed:', error.message);
} finally {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  server.close();
}
