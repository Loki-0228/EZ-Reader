/**
 * Throwaway diagnostic: does this Chromium accept `--load-extension` at all, and if the
 * EZ-Reader extension is rejected, what does the extension loader say?
 *
 * Runs three launches: a minimal known-good extension, EZ-Reader with verbose extension
 * logging, and EZ-Reader again but with the redundant `--disable-extensions-except`.
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, waitForEndpoint } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const TMP = path.join(ROOT, 'test-artifacts', 'probe');
const BROWSER = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let port = 9410;

async function launchAndList(label, extensionDir, extraFlags = []) {
  port += 1;
  const profile = path.join(TMP, `profile-${label}`);
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });

  const flags = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--enable-logging=stderr',
    '--v=1',
    `--load-extension=${extensionDir}`,
    ...extraFlags,
    'about:blank',
  ];

  const child = spawn(BROWSER, flags, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  try {
    const version = await waitForEndpoint(port, { timeoutMs: 45000 });
    const session = await CdpSession.connect({ url: version.webSocketDebuggerUrl, port });
    await new Promise((r) => setTimeout(r, 2500));
    const targets = await session.send('Target.getTargets');
    console.log(`\n=== ${label} ===`);
    for (const t of targets.targetInfos) {
      console.log(`  ${t.type.padEnd(18)} ${t.url.slice(0, 100)}`);
    }
    session.close();
  } catch (error) {
    console.log(`\n=== ${label} === LAUNCH FAILED: ${error.message}`);
  } finally {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  const text = log.join('');
  const interesting = text
    .split('\n')
    .filter((line) =>
      /extension|manifest|CRX|LoadExtension|load_extension|Invalid|error/i.test(line) &&
      !/QQBrowser|usagestats|crashpad|GoogleUpdate|fallback_task_provider|mojo|sync-confirmation/i.test(line),
    )
    .slice(0, 40);
  if (interesting.length) {
    console.log(`  --- loader log (${label}) ---`);
    for (const line of interesting) console.log(`  | ${line.trim().slice(0, 220)}`);
  } else {
    console.log('  (no extension-related log lines)');
  }
  return text;
}

await mkdir(TMP, { recursive: true });

// 1. Minimal known-good extension: proves --load-extension itself works.
const minimal = path.join(TMP, 'minimal');
await mkdir(minimal, { recursive: true });
await writeFile(
  path.join(minimal, 'manifest.json'),
  JSON.stringify(
    {
      manifest_version: 3,
      name: 'Probe Minimal',
      version: '1.0.0',
      content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'], run_at: 'document_idle' }],
    },
    null,
    2,
  ),
);
await writeFile(path.join(minimal, 'cs.js'), 'window.__PROBE_MINIMAL__ = true;\n');

await launchAndList('minimal-known-good', minimal);

// 2. The real extension, verbose.
await launchAndList('ez-reader', DIST);

// 3. Real extension without --disable-extensions-except (that flag is redundant and
//    in some builds suppresses loading entirely when combined with --load-extension).
await launchAndList('ez-reader-no-disable-except', DIST);

// 4. Real extension with a stripped manifest: drop host_permissions/permissions.
const stripped = path.join(TMP, 'stripped');
await rm(stripped, { recursive: true, force: true });
await mkdir(stripped, { recursive: true });
const { readFile, cp } = await import('node:fs/promises');
const manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
const strippedManifest = { ...manifest };
delete strippedManifest.permissions;
delete strippedManifest.host_permissions;
await writeFile(path.join(stripped, 'manifest.json'), JSON.stringify(strippedManifest, null, 2));
for (const f of ['content.js', 'background.js']) {
  await cp(path.join(DIST, f), path.join(stripped, f)).catch(() => {});
}
await launchAndList('ez-reader-no-permissions', stripped);
