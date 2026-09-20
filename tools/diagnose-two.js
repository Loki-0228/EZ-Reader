/**
 * Throwaway diagnostic: why is ::first-letter text-transform 'none', and why does the
 * 5000-block fixture yield a single block?
 *
 * Usage: node tools/diagnose-two.js [fixture.html]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const PROFILE = path.join(ROOT, 'test-artifacts', 'diag-two');
const PORT_HTTP = 8786;
const PORT_CDP = 9339;
const fixture = process.argv[2] || 'paper.html';
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

  console.log('=== extraction root choice ===');
  console.log(await iso('JSON.stringify(window.__ezr.probe(), null, 1)'));

  const opened = await iso('window.__ezr.open({})');
  console.log('\nopened:', JSON.stringify(opened));

  console.log('\n=== reader stylesheet: does it contain the rule? ===');
  console.log(
    await iso(`(function () {
      var sh = document.getElementById('ezr-root').shadowRoot;
      var css = Array.prototype.map.call(sh.querySelectorAll('style'), function (s) { return s.textContent; }).join('');
      return JSON.stringify({
        hasRule: css.indexOf('[data-ezr-w]::first-letter') !== -1,
        ruleText: (css.match(/[^\\n]*data-ezr-w\\][^\\n]*\\{[^}]*\\}/g) || []).slice(0, 3),
        hasImportant: css.indexOf('uppercase !important') !== -1,
        cssLength: css.length
      }, null, 1);
    })()`),
  );

  console.log('\n=== build a light-DOM probe with the same rule ===');
  console.log(
    await iso(`(async function () {
      var sh = document.getElementById('ezr-root').shadowRoot;
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { capitalizeFirst: true } });
      var host = document.getElementById('ezr-probe');
      if (host) host.remove();
      host = document.createElement('div');
      host.id = 'ezr-probe';
      document.documentElement.appendChild(host);
      var ps = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = Array.prototype.map.call(sh.querySelectorAll('style'), function (s) { return s.textContent; }).join('\\n');
      var art = document.createElement('div');
      art.className = 'ezr-article';
      var p = document.createElement('p');
      p.className = 'ezr-para';
      var w = document.createElement('span');
      w.setAttribute('data-ezr-probe', '1');
      w.textContent = 'hello';
      p.appendChild(w); art.appendChild(p);
      ps.appendChild(style); ps.appendChild(art);
      return JSON.stringify({ probeHost: !!document.getElementById('ezr-probe'), word: w.textContent });
    })()`),
  );

  const info = await page.domNodeIdFor('[data-ezr-probe]').then(() => 'resolved').catch((e) => `failed: ${e.message}`);
  console.log('probe node:', info);

  await session.send('CSS.enable', {}, page.sessionId).catch(() => {});
  try {
    const nodeId = await page.domNodeIdFor('[data-ezr-probe]', { refresh: true });
    const { computedStyle } = await session.send(
      'CSS.getComputedStyleForNode',
      { nodeId, pseudoElement: '::first-letter' },
      page.sessionId,
    );
    const wanted = computedStyle.filter((p) => ['text-transform', 'display', 'font-size'].includes(p.name));
    console.log('::first-letter of probe:', JSON.stringify(wanted));

  // Same query, but with the reader's actual .ezr-root wrapper present, and with
  // different selector shapes, to find which structure the browser will honour.
  await iso(`(function () {
    var host = document.getElementById('ezr-probe2');
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'ezr-probe2';
    document.documentElement.appendChild(host);
    var ps = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = [
      '.ezr-root { text-transform: none; }',
      '.plain::first-letter { text-transform: uppercase !important; }',
      '.wrap-outer .wrap-inner::first-letter { text-transform: uppercase !important; }',
      '#byid::first-letter { text-transform: uppercase !important; }',
      '.wrap-outer .wrap-inner-withid::first-letter { text-transform: uppercase !important; }'
    ].join('\\n');
    ps.appendChild(style);
    var root = document.createElement('div');
    root.className = 'ezr-root';
    var outer = document.createElement('div');
    outer.className = 'wrap-outer';
    var inner = document.createElement('div');
    inner.className = 'wrap-inner';
    inner.textContent = 'alpha';
    var withId = document.createElement('div');
    withId.className = 'wrap-inner-withid';
    withId.id = 'byid';
    withId.textContent = 'beta';
    var plain = document.createElement('div');
    plain.className = 'plain';
    plain.textContent = 'gamma';
    outer.appendChild(inner);
    outer.appendChild(withId);
    root.appendChild(outer);
    root.appendChild(plain);
    ps.appendChild(root);
    return true;
  })()`);

  await session.send('CSS.enable', {}, page.sessionId).catch(() => {});

  // Cross-check CDP's pseudo-element reporting against the browser's own
  // getComputedStyle(el, '::first-letter'), which can be called from JS. If JS says
  // 'uppercase' while CDP says 'none', the CSS is fine and the CDP reading is not
  // trustworthy for pseudo-elements.
  console.log(
    await iso(`(function () {
      var ps = document.getElementById('ezr-probe2').shadowRoot;
      function tt(sel) {
        var el = ps.querySelector(sel);
        if (!el) return 'no-element';
        return JSON.stringify({
          firstLetter: getComputedStyle(el, '::first-letter').textTransform,
          element: getComputedStyle(el).textTransform
        });
      }
      return JSON.stringify({ wrapInner: tt('.wrap-inner'), plain: tt('.plain') }, null, 1);
    })()`),
  );

  for (const selector of ['.wrap-inner', '.wrap-inner-withid', '.plain']) {
    try {
      const nodeId = await page.domNodeIdFor(selector, { refresh: true });
      await session.send('CSS.enable', {}, page.sessionId).catch(() => {});
      const { computedStyle } = await session.send(
        'CSS.getComputedStyleForNode',
        { nodeId, pseudoElement: '::first-letter' },
        page.sessionId,
      );
      const tt = computedStyle.find((p) => p.name === 'text-transform');
      const disp = computedStyle.find((p) => p.name === 'display');
      console.log(`probe2 ${selector} ::first-letter -> text-transform=${tt && tt.value} display=${disp && disp.value}`);
    } catch (error) {
      console.log(`probe2 ${selector} failed: ${error.message}`);
    }
  }
  } catch (error) {
    console.log('pseudo lookup failed:', error.message);
  }

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
