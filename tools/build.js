/**
 * EZ-Reader build — zero dependencies.
 *
 * Bundles `src/**` into a single content script using the fenced-module strategy in
 * tools/bundler.js, copies the extension pages, and refuses to produce a build that
 * Chromium would silently reject.
 *
 * Output: `dist/extension/` — load that folder as an unpacked extension.
 *
 * Every check below is a hard failure, never a warning, because each of them
 * corresponds to a failure mode that is invisible in the browser:
 *   - a parse error in the bundle  → content script never runs, console stays clean
 *   - a missing manifest target    → Chromium rejects the whole extension, log only
 *   - a bare/duplicate-import error → same as a parse error
 *
 * Usage: node tools/build.js
 */

import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BuildError, buildGraph, emitBundle } from './bundler.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist', 'extension');

/**
 * Copy a generated file only when its bytes changed.
 * @param {string} from source file
 * @param {string} to destination file
 * @returns {Promise<boolean>} whether the destination was written
 */
async function copyFileIfChanged(from, to) {
  const sourceBytes = await readFile(from);
  try {
    if ((await readFile(to)).equals(sourceBytes)) return false;
  } catch {
    // New generated file.
  }
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
  return true;
}

/**
 * Merge a generated directory into dist without touching files outside the build output.
 * Existing unrelated files are kept; generated files are written only when changed.
 * @param {string} from source directory
 * @param {string} to destination directory
 * @returns {Promise<number>} number of files written
 */
async function copyDirectoryDiff(from, to) {
  let changed = 0;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) changed += await copyDirectoryDiff(sourcePath, targetPath);
    else if (await copyFileIfChanged(sourcePath, targetPath)) changed += 1;
  }
  return changed;
}

/**
 * Fingerprint generated extension files so the options page can detect an
 * external Git/build update before the user reloads the unpacked extension.
 * @param {string} root generated extension directory
 * @returns {Promise<string>} stable SHA-256 fingerprint
 */
async function fingerprintExtension(root) {
  const hash = createHash('sha256');
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).replaceAll(path.sep, '/');
      if (relative === 'build-info.json') continue;
      if (entry.isDirectory()) await visit(file);
      else {
        hash.update(relative);
        hash.update('\0');
        hash.update(await readFile(file));
        hash.update('\0');
      }
    }
  };
  await visit(root);
  return hash.digest('hex');
}

/** Directories whose `.js` files are bundled into the content script. */
const MODULE_DIRS = ['core', 'dom', 'ui'];

/** The bundle entry point. */
const ENTRY = 'src/content.js';

/**
 * Files copied verbatim into dist/extension.
 *
 * The extension pages live under `src/pages/` but must resolve `../core/*.js` from the
 * output, so they are flattened into `dist/extension/pages/` while the core modules are
 * copied to `dist/extension/core/` (see copyStatic). Getting this mapping wrong is what
 * makes Chromium refuse the extension with "无法加载选项页".
 */
const STATIC_GLUE = [
  { from: 'src/background/window-toolbar.js', to: 'background/window-toolbar.js' },
  { from: 'manifest.json', to: 'manifest.json' },
  { from: 'src/background/documents.js', to: 'background/documents.js' },
  { from: 'src/pages/document-reader.html', to: 'pages/document-reader.html' },
  { from: 'src/pages/document-reader.css', to: 'pages/document-reader.css' },
  { from: 'src/pages/document-reader.js', to: 'pages/document-reader.js' },
  { from: 'src/pages/popup.html', to: 'pages/popup.html' },
  { from: 'src/pages/popup.css', to: 'pages/popup.css' },
  { from: 'src/pages/popup.js', to: 'pages/popup.js' },
  { from: 'src/pages/options.html', to: 'pages/options.html' },
  { from: 'src/pages/options.css', to: 'pages/options.css' },
  { from: 'src/pages/options.js', to: 'pages/options.js' },
  { from: 'src/pages/translation-options.js', to: 'pages/translation-options.js' },
  { from: 'src/pages/wordbook.js', to: 'pages/wordbook.js' },
];

/** Paths the manifest references that MUST exist in the built extension. */
const REQUIRED_OUTPUT = [
  'manifest.json',
  'background/documents.js',
  'pages/document-reader.html',
  'pages/document-reader.js',
  'pages/document-reader.css',
  'documents/parser.js',
  'documents/layout.js',
  'documents/translation.js',
  'vendor/pdfjs/pdf.mjs',
  'vendor/pdfjs/pdf.worker.mjs',
  'vendor/pdfjs/pdf_viewer.mjs',
  'vendor/pdfjs/pdf_viewer.css',
  'content.js',
  'background.js',
  'background/window-toolbar.js',
  'translation/background.js',
  'translation/service.js',
  'translation/config.js',
  'translation/prompts.js',
  'translation/credentials.js',
  'translation/word-card.js',
  'translation/card-download.js',
  'translation/wordbook.js',
  'translation/dictionary.js',
  'translation/vocabulary.js',
  'pages/wordbook.js',
  'pages/translation-options.js',
  'pages/popup.html',
  'pages/popup.css',
  'pages/popup.js',
  'pages/options.html',
  'pages/options.css',
  'pages/options.js',
];

/** Every module that will be bundled, dependencies first. */
function listModules() {
  const entries = [];
  for (const dir of MODULE_DIRS) {
    const abs = path.join(SRC, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      if (name.endsWith('.js')) entries.push(`src/${dir}/${name}`);
    }
  }
  entries.push(ENTRY);
  return entries;
}

async function copyStatic() {
  const skipped = [];
  let changed = 0;
  for (const directory of ['documents', 'vendor/pdfjs']) {
    changed += await copyDirectoryDiff(path.join(SRC, directory), path.join(DIST, directory));
  }
  await mkdir(path.join(DIST, 'translation'), { recursive: true });
  for (const name of await readdir(path.join(SRC, 'translation'))) {
    if (name.endsWith('.js') && await copyFileIfChanged(path.join(SRC, 'translation', name), path.join(DIST, 'translation', name))) changed += 1;
  }
  for (const { from: relFrom, to: relTo } of STATIC_GLUE) {
    const from = path.join(ROOT, relFrom);
    if (!existsSync(from)) {
      skipped.push(relFrom);
      continue;
    }
    const to = path.join(DIST, relTo);
    await mkdir(path.dirname(to), { recursive: true });
    if (await copyFileIfChanged(from, to)) changed += 1;
  }

  // Extension pages are real ES modules importing `../core/*.js`, so the core modules
  // are copied to dist/extension/core/ to keep the specifiers identical in the source
  // tree and in the build.
  const coreOut = path.join(DIST, 'core');
  await mkdir(coreOut, { recursive: true });
  const coreDir = path.join(SRC, 'core');
  if (existsSync(coreDir)) {
    for (const name of await readdir(coreDir)) {
      if (name.endsWith('.js') && await copyFileIfChanged(path.join(coreDir, name), path.join(coreOut, name))) changed += 1;
    }
  }

  // Debugging reference only. These unhashed copies are also what
  // tools/browser-test.js imports when it needs the real constants inside a page.
  const referenceDir = path.join(DIST, 'src', 'modules');
  await mkdir(referenceDir, { recursive: true });
  for (const dir of MODULE_DIRS) {
    const abs = path.join(SRC, dir);
    if (!existsSync(abs)) continue;
    for (const name of await readdir(abs)) {
      if (!name.endsWith('.js')) continue;
      if (await copyFileIfChanged(path.join(abs, name), path.join(referenceDir, `${dir}__${name}`))) changed += 1;
    }
  }
  return { skipped, changed };
}

async function main() {
  const entries = listModules();
  const missing = [...entries, 'src/background.js'].filter((rel) => !existsSync(path.join(ROOT, rel)));
  if (missing.length) {
    console.error(`[build] 缺少源文件，无法构建:\n  - ${missing.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(DIST, { recursive: true });

  const graph = buildGraph(ROOT, entries);

  if (graph.external.size) {
    console.error('[build] 内容脚本中出现裸模块导入（请使用工程内的相对路径模块）:');
    for (const [spec, files] of graph.external) {
      console.error(`  - ${spec}  ←  ${[...files].join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  const { bundled, modules } = emitBundle(graph, ENTRY);

  // A bundle that does not parse is an extension that silently does nothing.
  try {
    new Function(bundled);
  } catch (error) {
    console.error(`[build] 生成的 bundle 无法解析: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let changed = 0;
  const writeIfChanged = async (file, content) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    try {
      if ((await readFile(file)).equals(bytes)) return;
    } catch {
      // New generated file.
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    changed += 1;
  };
  await writeIfChanged(path.join(DIST, 'content.js'), bundled);
  await writeIfChanged(path.join(DIST, 'background.js'), await readFile(path.join(ROOT, 'src/background.js')));

  const { skipped, changed: copied } = await copyStatic();
  changed += copied;

  const absent = REQUIRED_OUTPUT.filter((rel) => !existsSync(path.join(DIST, rel)));
  if (absent.length) {
    console.error(
      `[build] dist/extension 缺少清单引用的文件，浏览器会拒绝加载整个扩展:\n  - ${absent.join('\n  - ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
  const fingerprint = await fingerprintExtension(DIST);
  const buildInfo = JSON.stringify({ version: manifest.version, fingerprint });
  await writeIfChanged(path.join(DIST, 'build-info.json'), buildInfo);

  const kb = (Buffer.byteLength(bundled, 'utf8') / 1024).toFixed(1);
  console.log(`[build] content.js   ${modules.length} modules, ${kb} KB`);
  for (const m of modules) console.log(`          · ${m}`);
  console.log('[build] background.js  (ES module service worker)');
  console.log('[build] pages/ + core/  (popup/options 及其 ESM 依赖)');
  console.log(`[build] dist/extension 差异更新: ${changed} 个文件已写入；未改动和额外文件均保留`);
  if (skipped.length) console.log(`[build] 提示: 跳过缺失的源文件 ${skipped.join(', ')}`);
  console.log('[build] 输出目录: dist/extension');
  console.log('[build] 安装: Edge/Chrome 打开扩展管理页 → 开启开发者模式 → 加载解压缩的扩展 → 选 dist/extension');
}

main().catch((error) => {
  console.error(error instanceof BuildError ? `[build] ${error.message}` : error);
  process.exitCode = 1;
});
