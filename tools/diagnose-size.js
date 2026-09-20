/**
 * Throwaway: why is the h1 rendered far larger than the configured heading size?
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const PROFILE = path.join(ROOT, 'test-artifacts', 'diag-size');
const PORT_HTTP = 8792;
const PORT_CDP = 9345;
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

await rm(PROFILE, { recursive: true, force: true });
await mkdir(PROFILE, { recursive: true });

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'paper.html';
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
  const page = await CdpPage.attach(session, { url: `http://localhost:${PORT_HTTP}/paper.html` });
  await page.setViewport(1280, 900);
  await page.goto(`http://localhost:${PORT_HTTP}/paper.html`, { timeoutMs: 30000 });

  const contextId = await page.findContext('typeof window.__ezr === "object"', { timeoutMs: 25000 });
  const iso = (e) => page.evaluate(e, { contextId });
  await iso('(async () => { await window.__ezrSend({ type: "ezr:reset-settings" }); return true; })()');
  await iso('window.__ezr.open({})');
  await new Promise((r) => setTimeout(r, 400));

  console.log(
    await iso(`(function () {
      var sh = document.getElementById('ezr-root').shadowRoot;
      var root = sh.querySelector('.ezr-root');
      var body = sh.querySelector('.ezr-body');
      var art = sh.querySelector('.ezr-article');
      var holder = art.querySelector('.ezr-article') || art;
      var h1 = holder.querySelector('h1');
      var p = holder.querySelector('p');
      var cs = function (el) { return el ? getComputedStyle(el) : null; };
      var readVar = function (name) { return root.style.getPropertyValue(name); };
      return JSON.stringify({
        scale: readVar('--ezr-scale'),
        sizeBody: readVar('--ezr-size-body'),
        sizeH1: readVar('--ezr-size-h1'),
        font: readVar('--ezr-font'),
        measure: readVar('--ezr-measure'),
        h1: h1 ? {
          tag: h1.tagName, cls: h1.className,
          fontSize: cs(h1).fontSize, lineHeight: cs(h1).lineHeight,
          rect: Math.round(h1.getBoundingClientRect().width) + 'x' + Math.round(h1.getBoundingClientRect().height),
          text: (h1.textContent || '').slice(0, 40)
        } : null,
        p: p ? { fontSize: cs(p).fontSize, lineHeight: cs(p).lineHeight, width: Math.round(p.getBoundingClientRect().width) } : null,
        rootFontSize: cs(root).fontSize,
        artFontSize: cs(holder).fontSize,
        bodyWidth: Math.round(body.getBoundingClientRect().width),
        artWidth: Math.round(art.getBoundingClientRect().width),
        rootZoom: cs(root).zoom
      }, null, 1);
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
