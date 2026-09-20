/**
 * Throwaway diagnostic: why does extraction return "empty"?
 *
 * Runs the reader's own pipeline stages inside the content script's isolated world and
 * prints what each stage produced.
 *
 * Usage: node tools/diagnose-extract.js [fixture.html]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const PROFILE = path.join(ROOT, 'test-artifacts', 'diag-extract-profile');
const PORT_HTTP = 8784;
const PORT_CDP = 9337;
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
const log = [];
child.stdout.on('data', (d) => log.push(String(d)));
child.stderr.on('data', (d) => log.push(String(d)));

try {
  const version = await waitForEndpoint(PORT_CDP, { timeoutMs: 45000 });
  const session = await CdpSession.connect({ url: version.webSocketDebuggerUrl, port: PORT_CDP });
  const page = await CdpPage.attach(session, { url: `http://localhost:${PORT_HTTP}/${fixture}` });
  await page.setViewport(1280, 900);
  await page.goto(`http://localhost:${PORT_HTTP}/${fixture}`, { timeoutMs: 30000 });

  const contextId = await page.findContext('typeof window.__ezr === "object"', { timeoutMs: 25000 });
  console.log('context:', contextId, '| console lines:', page.console.length);
  for (const line of page.console.slice(-10)) console.log(`  [${line.level}] ${line.text.slice(0, 220)}`);

  if (contextId === null) {
    console.log('content script not found');
  } else {
    const probe = await page.evaluate('JSON.stringify(window.__ezr.probe(), null, 2)', { contextId });
    console.log('\n=== probe ===');
    console.log(probe);

    console.log('\n=== main-world sanity (outside the isolated world) ===');
    console.log('body children:', await page.evaluate('document.body.children.length'));
    console.log('body text length:', await page.evaluate('document.body.textContent.length'));
    console.log('main/article present:', await page.evaluate('!!document.querySelector("main, article, #article, #content")'));
  }

  session.close();
} catch (error) {
  console.error('diagnose failed:', error.message);
  console.error(log.join('').split('\n').slice(-20).join('\n'));
} finally {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  server.close();
}
