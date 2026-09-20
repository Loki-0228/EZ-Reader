/**
 * Throwaway diagnostic: is the extension loaded, and does the content script run?
 * Dumps targets, execution contexts, console output and the isolated-world marker.
 *
 * Usage: node tools/diagnose.js [fixtureName]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const PROFILE = path.join(ROOT, 'test-artifacts', 'diag-profile');
const PORT_HTTP = 8781;
const PORT_CDP = 9335;
const fixture = process.argv[2] || 'paper.html';

const browser = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

await rm(PROFILE, { recursive: true, force: true });
await mkdir(PROFILE, { recursive: true });

const sources = new Map();
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
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT_CDP}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-crash-reporter',
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);
const browserLog = [];
child.stdout.on('data', (d) => browserLog.push(String(d)));
child.stderr.on('data', (d) => browserLog.push(String(d)));

try {
  const version = await waitForEndpoint(PORT_CDP, { timeoutMs: 45000 });
  console.log('browser:', version.Browser);

  const session = await CdpSession.connect({ url: version.webSocketDebuggerUrl, port: PORT_CDP });

  // What targets exist right after launch? A loaded extension shows up as an
  // extension service worker / page target.
  const targets = await session.send('Target.getTargets');
  console.log('\n=== targets immediately after launch ===');
  for (const t of targets.targetInfos) {
    console.log(`  ${t.type.padEnd(22)} ${t.url.slice(0, 110)}`);
  }

  const page = await CdpPage.attach(session, { url: `http://localhost:${PORT_HTTP}/${fixture}` });
  await page.setViewport(1280, 900);
  await page.goto(`http://localhost:${PORT_HTTP}/${fixture}`, { timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 3000));

  console.log('\n=== targets after navigation ===');
  const targets2 = await session.send('Target.getTargets');
  for (const t of targets2.targetInfos) {
    console.log(`  ${t.type.padEnd(22)} ${t.url.slice(0, 110)}`);
  }

  console.log('\n=== execution contexts ===');
  for (const c of page.executionContexts()) {
    console.log(`  #${String(c.id).padEnd(6)} origin=${String(c.origin).padEnd(30)} name=${c.name} aux=${JSON.stringify(c.auxData)}`);
  }

  console.log('\n=== isolated-world marker probes (main world) ===');
  for (const expr of [
    'typeof window.__ezr',
    'typeof window.__EZR_CONTENT_LOADED__',
    'document.querySelectorAll("#ezr-root").length',
    'location.href',
    'document.title',
  ]) {
    try {
      console.log(`  ${expr} => ${JSON.stringify(await page.evaluate(expr))}`);
    } catch (error) {
      console.log(`  ${expr} => ERROR ${error.message}`);
    }
  }

  console.log('\n=== per-context probe (every JS world in this target) ===');
  for (const context of page.executionContexts()) {
    const probe = async (expression) => {
      try {
        const result = await session.send(
          'Runtime.evaluate',
          { expression, contextId: context.id, returnByValue: true },
          page.sessionId,
        );
        if (result.exceptionDetails) {
          return `THROW ${result.exceptionDetails.text || ''} ${result.exceptionDetails.exception?.description || ''}`.trim();
        }
        return JSON.stringify(result.result?.value);
      } catch (error) {
        return `ERR ${error.message}`;
      }
    };
    console.log(
      `  #${context.id} (${context.origin}${context.name ? ` name=${context.name}` : ''})` +
        `\n      __ezr=${await probe('typeof window.__ezr')}` +
        ` movedMarker=${await probe('typeof window.__EZR_CONTENT_LOADED__')}` +
        ` chrome=${await probe('typeof chrome')}` +
        ` chromeRuntime=${await probe('typeof (chrome && chrome.runtime)')}` +
        ` isolated=${await probe('typeof (chrome && chrome.runtime && chrome.runtime.id)')}`,
    );
  }

  // Ask the extension's own service worker whether it is alive.
  const targets3 = await session.send('Target.getTargets');
  const worker = targets3.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  if (worker) {
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    const evalIn = async (expression) => {
      const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) return `THROW ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`;
      return JSON.stringify(result.result?.value);
    };
    console.log('\n=== EZ-Reader service worker ===');
    console.log('  id            =', await evalIn('chrome.runtime.id'));
    console.log('  getManifest   =', await evalIn('JSON.stringify(chrome.runtime.getManifest().name)'));
    console.log('  contentScripts=', await evalIn('JSON.stringify(chrome.runtime.getManifest().content_scripts)'));
    console.log('  storage keys  =', await evalIn('(async()=>JSON.stringify(Object.keys(await chrome.storage.local.get(null))))()'));
    console.log('  regScripts    =', await evalIn('(async()=>{const r=await chrome.scripting.getRegisteredContentScripts();return JSON.stringify(r)})()'));
  } else {
    console.log('\n(no EZ-Reader service worker target found)');
  }

  console.log('\n=== console output captured ===');
  for (const line of page.console.slice(-40)) console.log(`  [${line.level}] ${line.text.slice(0, 300)}`);

  console.log('\n=== browser stderr/stdout (tail) ===');
  console.log(browserLog.join('').split('\n').slice(-25).join('\n'));

  session.close();
} catch (error) {
  console.error('diagnose failed:', error.message);
  console.error(browserLog.join('').split('\n').slice(-30).join('\n'));
} finally {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  server.close();
}
