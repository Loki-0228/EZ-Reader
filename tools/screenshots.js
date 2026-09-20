/**
 * Visual capture: screenshots of the reader view while it is OPEN, plus a few variants
 * (outline, settings panel, capitalized text, dark theme, zoomed).
 *
 * The acceptance suite captures after closing the reader (to prove the page is restored),
 * so this exists to actually look at the product.
 *
 * Usage: node tools/screenshots.js [fixture.html ...]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const OUT = path.join(ROOT, 'test-artifacts', 'shots');
const PROFILE = path.join(ROOT, 'test-artifacts', 'shots-profile');
const PORT_HTTP = 8790;
const PORT_CDP = 9343;
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const fixtures = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['paper.html', 'divsoup.html', 'rich.html'];

await rm(PROFILE, { recursive: true, force: true });
await mkdir(PROFILE, { recursive: true });
await mkdir(OUT, { recursive: true });

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
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
    '--force-device-scale-factor=1',
    `--load-extension=${DIST}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);

try {
  const version = await waitForEndpoint(PORT_CDP, { timeoutMs: 45000 });
  const session = await CdpSession.connect({ url: version.webSocketDebuggerUrl, port: PORT_CDP });
  const page = await CdpPage.attach(session, { url: 'about:blank' });
  await page.setViewport(1280, 900);
  page.console.length = 0;

  for (const fixture of fixtures) {
    const name = fixture.replace(/\.html$/, '');
    await page.goto(`http://localhost:${PORT_HTTP}/${fixture}`);
    const contextId = await page.findContext('typeof window.__ezr === "object"', { timeoutMs: 25000 });
    if (contextId === null) {
      console.log(`${name}: 内容脚本未就绪`);
      continue;
    }
    const iso = (e) => page.evaluate(e, { contextId });

    await iso('(async () => { await window.__ezrSend({ type: "ezr:reset-settings" }); return true; })()');
    const opened = await iso('window.__ezr.open({})');
    if (!opened || !opened.ok) {
      console.log(`${name}: 打开失败 ${JSON.stringify(opened)}`);
      continue;
    }
    await new Promise((r) => setTimeout(r, 400));

    const shot = async (suffix) => {
      const file = path.join(OUT, `${name}${suffix}.png`);
      await page.screenshot({ path: file });
      return file;
    };

    console.log(`${name}: ${opened.blocks} 块 → ${path.relative(ROOT, await shot(''))}`);

    // Settings drawer: desktop, theme choices, dark theme, and narrow viewport.
    await iso(`document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-btn-settings').click()`);
    await new Promise((r) => setTimeout(r, 250));
    await shot('-settings');
    await iso(`document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-settings-scroll').scrollTop = 10000`);
    await shot('-settings-display');
    await iso(`document.getElementById('ezr-root').shadowRoot.querySelector('input[name="ezr-theme"][value="dark"]').click()`);
    await new Promise((r) => setTimeout(r, 250));
    await shot('-settings-dark');
    await page.setViewport(390, 844);
    await iso(`document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-settings-scroll').scrollTop = 0`);
    await new Promise((r) => setTimeout(r, 250));
    await shot('-settings-mobile');
    await iso(`document.getElementById('ezr-root').shadowRoot.querySelector('input[name="ezr-theme"][value="light"]').click()`);
    await new Promise((r) => setTimeout(r, 250));
    await shot('-settings-mobile-light');
    await iso(`document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-settings-close').click()`);
    await page.setViewport(1280, 900);

    // outline panel
    await iso('(async () => { await window.__ezrSend({ type: "ezr:update-settings", patch: { showOutline: true } }); return true; })()');
    await new Promise((r) => setTimeout(r, 250));
    await shot('-outline');

    // capitalize every word + dark theme
    await iso('(async () => { await window.__ezrSend({ type: "ezr:update-settings", patch: { capitalizeFirst: true, theme: "dark" } }); return true; })()');
    await new Promise((r) => setTimeout(r, 350));
    await shot('-caps-dark');

    // sepia + a different font
    await iso('(async () => { await window.__ezrSend({ type: "ezr:update-settings", patch: { theme: "sepia", fontId: "serif-palatino", bodyFontSize: 19, lineHeight: 1.9 } }); return true; })()');
    await new Promise((r) => setTimeout(r, 350));
    await shot('-sepia-large');

    await iso('(async () => { await window.__ezrSend({ type: "ezr:update-settings", patch: { theme: "light", fontId: "serif-georgia", bodyFontSize: 16, lineHeight: 1.6, capitalizeFirst: false, showOutline: false } }); return true; })()');
    await iso('window.__ezr.close()');
    await new Promise((r) => setTimeout(r, 200));

    const errors = page.console.filter((c) => c.level === 'error' || c.level === 'exception');
    if (errors.length) {
      console.log(`  控制台异常: ${errors.slice(0, 2).map((e) => e.text.slice(0, 160)).join(' | ')}`);
    }
    page.console.length = 0;
  }

  session.close();
} catch (error) {
  console.error('screenshot run failed:', error.message);
  process.exitCode = 1;
} finally {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  server.close();
  await writeFile(path.join(OUT, 'README.txt'), 'EZ-Reader reader-view screenshots (reader open).\n', 'utf8').catch(() => {});
}
