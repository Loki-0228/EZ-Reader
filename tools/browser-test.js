/**
 * EZ-Reader browser acceptance suite — zero dependencies.
 *
 * Launches the installed Chromium browser (Edge by default) headless with the freshly
 * built extension loaded, drives it over the DevTools Protocol, and asserts the five
 * product requirements plus the "exit restores the page unchanged" guarantee.
 *
 *   node tools/browser-test.js                 # all suites
 *   node tools/browser-test.js --only=paper    # a single suite
 *   node tools/browser-test.js --headed        # watch it run
 *
 * Two JS worlds are in play and must not be confused:
 *   - `page.evaluate(...)` runs in the page's MAIN world: use it for the DOM.
 *   - `iso(...)` (defined in the suite loop) runs in the CONTENT SCRIPT's isolated
 *     world, which shares the DOM but not the JS heap. `window.__ezr`, `window.__t`
 *     and `window.__ezrK` exist only there — a main-world `window.__ezr` is always
 *     undefined, which is exactly what "extension not injected" looks like.
 *   - `page.pseudoComputedStyle(...)` goes through CDP, which resolves nodes in the
 *     MAIN world, and is the only way to read a `::first-letter` computed style.
 *
 * Launching Chromium needs unrestricted process/IPC access: under a confined sandbox
 * the browser cannot create its IPC channels and exits immediately.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';
import { translationChecks } from './translation-checks.js';
import { fullTranslationChecks } from './full-translation-checks.js';
import { toolbarChecks } from './toolbar-checks.js';
import { textTranslationChecks } from './text-translation-checks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const ARTIFACTS = path.join(ROOT, 'test-artifacts');
const PROFILE = path.join(ARTIFACTS, 'edge-profile');
const PORT_HTTP = Number(process.env.EZR_TEST_PORT || 8799);
const PORT_CDP = Number(process.env.EZR_CDP_PORT || 9333);
const BASE = `http://localhost:${PORT_HTTP}`;

const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null;

const BROWSER_CANDIDATES = [
  process.env.EZR_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/* ------------------------------------------------------------------ reporting */

const results = [];
let currentSuite = 'general';

function check(label, passed, detail) {
  results.push({ suite: currentSuite, label, passed: !!passed, detail });
  const mark = passed ? 'PASS' : 'FAIL';
  const suffix = detail === undefined || detail === '' ? '' : `  → ${detail}`;
  console.log(`  [${mark}] ${label}${suffix}`);
}

const info = (message) => console.log(`         · ${message}`);

/* --------------------------------------------------------------- page harness */

/**
 * Injected into the content script's isolated world once per fixture. Everything the
 * checks need to observe stays inside that world so nothing crosses the protocol
 * boundary by reference.
 */
const HARNESS = `
window.__t = (function () {
  var out = [];
  function add(label, pass, detail) {
    out.push({ label: label, pass: !!pass, detail: detail === undefined || detail === null ? '' : String(detail) });
  }
  function shadow() {
    var host = document.getElementById('ezr-root');
    return host && host.shadowRoot ? host.shadowRoot : null;
  }
  function article(sh) { return sh ? sh.querySelector('.ezr-article') : null; }
  function textOf(el) {
    if (!el) return '';
    return Array.prototype.map.call(el.childNodes, function (n) { return n.textContent; }).join('');
  }
  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : NaN; }
  function rect(el) { var r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }
  // Real line height, measured two ways:
  //   1. the computed CSS line-height when it resolves to a length (exact, and what the
  //      spec means by "1.5 倍行距");
  //   2. otherwise (font-size multiples, unitless values) the distance between two line
  //      boxes in the same text node, via Range rects.
  // An earlier version measured an inline-block probe with height:0, which reported 0 and
  // made the "gap > 1.5x line height" assertion vacuous.
  function measureLineHeight(block) {
    if (!block) return NaN;
    var css = parseFloat(getComputedStyle(block).lineHeight);
    if (isFinite(css) && css > 0) return css;
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var node = walker.nextNode();
    while (node) {
      var value = node.nodeValue || '';
      if (value.trim().length > 1) {
        var range = document.createRange();
        for (var i = 0; i < value.length - 1; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          var a = range.getBoundingClientRect();
          if (a.height <= 0) continue;
          for (var j = i + 1; j < value.length; j++) {
            range.setStart(node, j);
            range.setEnd(node, j + 1);
            var b = range.getBoundingClientRect();
            if (b.height <= 0) continue;
            var delta = Math.abs(b.top - a.top);
            if (delta > 0.5) return delta;
          }
        }
      }
      node = walker.nextNode();
    }
    var size = parseFloat(getComputedStyle(block).fontSize);
    return isFinite(size) ? size * 1.2 : NaN;
  }
  function gapBetween(a, b) { return rect(b).top - rect(a).bottom; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  return {
    add: add, shadow: shadow, article: article, textOf: textOf, px: px,
    rect: rect, measureLineHeight: measureLineHeight, gapBetween: gapBetween,
    wait: wait, report: function () { return out; }
  };
})();
`;

/**
 * Pull the shipped constants out of the content script's debug surface.
 *
 * Deliberately NOT a dynamic `import()` of the module files: content-script resources are
 * not web-accessible by default, and adding them to the manifest purely to let a test
 * import them would widen the extension's exposure for no product benefit.
 */
const LOAD_CONSTANTS = `
(function () {
  const k = window.__ezrConst;
  if (!k) return false;
  window.__ezrK = {
    defaults: JSON.parse(JSON.stringify(k.defaults)),
    fonts: k.fonts.map((f) => ({ id: f.id, stack: f.stack })),
    limits: JSON.parse(JSON.stringify(k.limits)),
    headingSizes: k.headingSizes.slice()
  };
  return true;
})()
`;

/* --------------------------------------------------------------- the fixtures */

const SUITES = {
  toolbar: { fixture: 'paper.html' },
  // `full-translation` asserts what happens when NO DeepSeek key is configured, so it
  // must run before any suite that stores one (`translation`, then `text-translation`).
  'full-translation': { fixture: 'full-translation.html' },
  translation: { fixture: 'translation.html' },
  'text-translation': { fixture: 'paper.html' },
  interaction: { fixture: 'interaction.html' },
  'interaction-styled': { fixture: 'interaction-styled.html' },
  paper: {
    fixture: 'paper.html',
    async build() {
      return `
      var sh = __t.shadow();
      __t.add('阅读视图已挂载到 Shadow DOM', !!sh, sh ? '' : 'no shadowRoot');
      if (!sh) return;
      var art = __t.article(sh);
      var headings = art.querySelectorAll('h1,h2,h3,h4,h5,h6');
      __t.add('渲染出分等级标题 (>=6 个)', headings.length >= 6, headings.length + ' 个');

      var levels = Array.prototype.map.call(headings, function (h) { return Number(h.tagName.slice(1)); });
      var distinct = levels.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
      __t.add('标题层级在 1..6 之间', levels.every(function (l) { return l >= 1 && l <= 6; }), '层级=' + distinct.join(','));
      __t.add('至少 4 个不同层级', distinct.length >= 4, '层级=' + distinct.join(','));
      __t.add('存在 h1 顶层标题', distinct.indexOf(1) !== -1, '层级=' + distinct.join(','));

      var sizes = Array.prototype.map.call(headings, function (h) { return __t.px(getComputedStyle(h).fontSize); });
      var paras = art.querySelectorAll('.ezr-para');
      __t.add('正文段落数 >= 10', paras.length >= 10, paras.length + ' 段');
      var bodySize = paras.length ? __t.px(getComputedStyle(paras[0]).fontSize) : NaN;
      var h1Size = sizes[levels.indexOf(1)];
      __t.add('h1 字号大于正文', h1Size > bodySize, 'h1=' + h1Size + ' body=' + bodySize);

      // Font size must DECREASE as the heading level number increases. Comparing
      // consecutive headings in document order would be wrong: a document may go
      // h3 → h2 when a subsection ends and a new section starts.
      var sizeByLevel = {};
      for (var s = 0; s < levels.length; s++) {
        var lv = levels[s];
        if (sizeByLevel[lv] === undefined || sizes[s] > sizeByLevel[lv]) sizeByLevel[lv] = sizes[s];
      }
      var orderedLevels = Object.keys(sizeByLevel).map(Number).sort(function (a, b) { return a - b; });
      var inversion = null;
      for (var o = 1; o < orderedLevels.length; o++) {
        var coarser = orderedLevels[o - 1];
        var finer = orderedLevels[o];
        if (sizeByLevel[finer] > sizeByLevel[coarser] + 0.6) {
          inversion = 'h' + coarser + '(' + sizeByLevel[coarser] + ') < h' + finer + '(' + sizeByLevel[finer] + ')';
        }
      }
      __t.add('字号随标题层级递减', inversion === null, inversion ||
        orderedLevels.map(function (l) { return 'h' + l + '=' + sizeByLevel[l]; }).join(' '));

      var lh = __t.measureLineHeight(paras[0]);
      var gap = __t.gapBetween(paras[0], paras[1]);
      __t.add('段间距 > 1.5 倍行高', gap > 1.5 * lh + 0.5,
        'gap=' + gap.toFixed(1) + ' 1.5L=' + (1.5 * lh).toFixed(1) + ' L=' + lh.toFixed(1));
      var lhCss = __t.px(getComputedStyle(paras[0]).lineHeight);
      __t.add('行距已生效 (>20px)', lhCss > 20, lhCss + 'px');
      `;
    },
  },

  divsoup: {
    fixture: 'divsoup.html',
    async build() {
      return `
      var sh = __t.shadow();
      if (!sh) { __t.add('阅读视图已挂载', false, 'no shadowRoot'); return; }
      var art = __t.article(sh);
      var headings = art.querySelectorAll('h1,h2,h3,h4,h5,h6');
      __t.add('无原生标题标签也能产出分级标题', headings.length >= 3, headings.length + ' 个标题');
      var levels = Array.prototype.map.call(headings, function (h) { return Number(h.tagName.slice(1)); });
      var distinct = levels.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
      __t.add('至少产出 2 个不同层级', distinct.length >= 2, '层级=' + distinct.join(','));

      var paras = art.querySelectorAll('.ezr-para');
      __t.add('正文段落数 >= 12', paras.length >= 12, paras.length + ' 段');

      var lh = __t.measureLineHeight(paras[0]);
      var gap = __t.gapBetween(paras[0], paras[1]);
      __t.add('密集段落被重新撑开 (gap > 1.5L)', gap > 1.5 * lh + 0.5,
        'gap=' + gap.toFixed(1) + ' 1.5L=' + (1.5 * lh).toFixed(1));

      var longParas = Array.prototype.filter.call(paras, function (p) { return __t.textOf(p).length > 90; });
      __t.add('长段被识别为正文', longParas.length >= 8, longParas.length + ' 个长段');

      var all = __t.textOf(art);
      __t.add('噪声（相关阅读/评论）未被收进正文', all.indexOf('Related') === -1 && all.indexOf('Comments') === -1, '');
      `;
    },
  },

  rich: {
    fixture: 'rich.html',
    async build() {
      return `
      var sh = __t.shadow();
      if (!sh) { __t.add('阅读视图已挂载', false, 'no shadowRoot'); return; }
      var art = __t.article(sh);
      var html = art.innerHTML;
      var all = __t.textOf(art);

      __t.add('script 内容被完全剥离', html.indexOf('EZR_SHOULD_BE_STRIPPED') === -1, '');
      __t.add('display:none 内容被丢弃', html.indexOf('EZR_HIDDEN_TEXT') === -1, '');
      __t.add('保留行内强调 strong', !!art.querySelector('.ezr-para strong'), '');
      __t.add('保留链接 a[href]', !!art.querySelector('.ezr-para a[href]'), '');
      __t.add('保留行内 code 语义', !!art.querySelector('code'), '');
      __t.add('列表被保留 (li)', !!art.querySelector('li'), '');
      __t.add('表格被保留', !!art.querySelector('table'), '');
      __t.add('代码块被保留', !!art.querySelector('pre, .ezr-code'), '');

      var bad = art.querySelector('a[href^="javascript:"], a[href^="JavaScript:"], a[href^="  Java"]');
      __t.add('javascript: 链接被降级为非链接', !bad, bad ? bad.getAttribute('href') : '');
      __t.add('降级后的链接文字仍可见', /bad link/i.test(all), '');
      __t.add('事件属性全部剥除', html.indexOf('onclick') === -1 && html.indexOf('onerror') === -1, '');
      __t.add('内联 style 属性全部剥除', html.indexOf(' style=') === -1, '');
      __t.add('表格结构完整', !!art.querySelector('table tbody'), '');
      `;
    },
  },

  long: {
    fixture: 'long.html',
    perf: true,
    async build() {
      return `
      var sh = __t.shadow();
      if (!sh) { __t.add('阅读视图已挂载', false, 'no shadowRoot'); return; }
      var art = __t.article(sh);
      // renderDoc returns a fragment containing div.ezr-article, and mounting appends that
      // fragment, so the blocks are the grandchildren of the host article element.
      var holder = art.querySelector('.ezr-article') || art;
      var n = holder.children.length;
      __t.add('大文档渲染块数 >= 4000', n >= 4000, n + ' 块');
      var headings = art.querySelectorAll('h1,h2,h3,h4,h5,h6');
      __t.add('大文档标题抽取 (>20)', headings.length > 20, headings.length + ' 个');
      var t0 = performance.now();
      __t.measureLineHeight(art.querySelector('.ezr-para'));
      var cost = performance.now() - t0;
      __t.add('单次布局读取开销可接受 (<200ms)', cost < 200, cost.toFixed(1) + 'ms');
      `;
    },
  },

  'lazy-iframe': {
    fixture: 'lazy-iframe.html',
    async build() {
      return `
      var sh = __t.shadow();
      if (!sh) { __t.add('阅读视图已挂载', false, 'no shadowRoot'); return; }
      var art = __t.article(sh);
      var paras = art.querySelectorAll('.ezr-para');
      __t.add('主文档正文被抽取', paras.length >= 6, paras.length + ' 段');
      var all = __t.textOf(art);
      __t.add('收起的 details 内容未被抽取', all.indexOf('EZR_COLLAPSED_TEXT') === -1, '');
      var overflow = getComputedStyle(document.documentElement).overflow;
      __t.add('阅读期间锁定了页面滚动', overflow === 'hidden' || overflow === 'clip', 'html overflow=' + overflow);
      `;
    },
  },

  cjk: {
    fixture: 'cjk.html',
    async build() {
      return `
      var sh = __t.shadow();
      if (!sh) { __t.add('阅读视图已挂载', false, 'no shadowRoot'); return; }
      var art = __t.article(sh);
      var all = __t.textOf(art);
      __t.add('中文正文被抽取 (>400 字符)', all.length > 400, all.length + ' 字符');
      var paras = art.querySelectorAll('.ezr-para');
      __t.add('中文段落未被拆碎 (>=5 段)', paras.length >= 5, paras.length + ' 段');
      var han = (all.match(/[\\u4e00-\\u9fff]/g) || []).length;
      __t.add('文中含中文汉字 (>200)', han > 200, han + ' 个');
      window.__ezrCjkBefore = all;
      `;
    },
  },
};

/* ------------------------------------------------------------------- browser */

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function launch(browser) {
  const flags = [
    headed ? '' : '--headless=new',
    `--remote-debugging-port=${PORT_CDP}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    'about:blank',
  ].filter(Boolean);

  const child = spawn(browser, flags, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  child.on('error', (error) => log.push(`spawn error: ${error.message}`));
  return { child, log };
}

async function startFixtureServer() {
  const fixtureDir = path.join(ROOT, 'fixtures');
  const names = (await readdir(fixtureDir)).filter((n) => n.endsWith('.html'));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, BASE);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!names.includes(rel)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(path.join(fixtureDir, rel));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
    } catch (error) {
      res.writeHead(500).end(String(error && error.message));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT_HTTP, '127.0.0.1', resolve);
  });
  return { server, names };
}

/* ------------------------------------------------------------- shared checks */

/** Reset persisted settings so every suite starts from a known state. */
async function resetSettings(page, iso) {
  await iso(`
    (async () => {
      await window.__ezrSend({ type: 'ezr:reset-settings' });
      await new Promise((r) => chrome.storage.local.set({ 'ezr:pos': {} }, r));
      await window.__ezrSend({ type: 'ezr:reload' });
      return true;
    })()
  `);
}

/** Poll until the reader is gone, so byte-comparison never races the teardown. */
async function waitForReaderClosed(page) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    // The shadow host lives in the light DOM, so the main world can see it; no need to
    // reach into the content script's isolated world here.
    if (await page.evaluate('!document.getElementById("ezr-root")')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Settings persistence and rendering, driven through the same dispatcher the popup
 * uses. Every hard-coded expectation comes from `window.__ezrK`, which is loaded from
 * the shipped modules, so a drifting constant fails the test instead of hiding.
 */
async function interactionChecks(page, iso) {
  const initialHtml = await iso('document.documentElement.outerHTML');
  await iso(`window.__sourceRefs = [document.getElementById('source-a'), document.getElementById('source-b')]`);
  const status = () => iso(`window.__ezrSend({ type: 'ezr:status' })`);
  const pause = () => iso('new Promise(resolve => setTimeout(resolve, 120))');
  const click = async (selector, inReader = false, button = 'left') => {
    const point = await iso(`(function () {
      var root = ${inReader ? "document.getElementById('ezr-root').shadowRoot" : 'document'};
      var el = root.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await page.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, page.sessionId);
    await page.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 }, page.sessionId);
    await page.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 }, page.sessionId);
    await pause();
  };
  const escape = async () => {
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page.sessionId);
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page.sessionId);
    await pause();
  };
  const readerText = () => iso(`document.getElementById('ezr-root')?.shadowRoot.querySelector('.ezr-article').textContent || ''`);
  const intact = () => iso(`__sourceRefs[0] === document.getElementById('source-a') && __sourceRefs[1] === document.getElementById('source-b') && __sourceRefs.every(el => el.parentElement === document.body)`);
  const sourceLayout = () => iso(`__sourceRefs.map(el => {
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return [r.left + scrollX, r.top + scrollY, r.width, r.height, s.fontFamily, s.fontSize, s.display, s.padding, s.backgroundColor];
  })`);
  const originalLayout = JSON.stringify(await sourceLayout());
  const panelState = () => iso(`(function () {
    var sh = document.getElementById('ezr-root').shadowRoot;
    var panel = sh.querySelector('.ezr-settings');
    var control = panel.querySelector('[data-ezr-setting="bodyFontSize"]');
    var r = control.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var hit = sh.elementFromPoint(x, y);
    return { visible: r.width > 0 && r.height > 0 && x > 0 && x < innerWidth && y > 0 && y < innerHeight,
      reachable: hit === control, open: panel.getAttribute('aria-hidden') === 'false' && !panel.inert };
  })()`);

  const probe = await iso('window.__ezr.probe()');
  check('短页面无法自动提取（用于验证手动选区入口）', probe.blocks === 0);
  const started = await iso(`window.__ezrSend({ type: 'ezr:pick' })`);
  let state = await status();
  check('工具栏原网页模式可直接选择区域', started.ok && state.picking && state.active && state.previewing);
  await click('#empty');
  state = await status();
  check('点到空白区域后仍可继续选择', state.picking && state.previewing);
  await click('#inline-target');
  state = await status();
  check('点击行内文字可读取对应短段落', state.active && !state.picking && (await readerText()).trim() === 'Original alpha.');
  check('选区不会移动或替换原网页节点', await intact());

  await click('.ezr-btn-settings', true);
  await pause();
  const readingPanel = await panelState();
  check('阅读模式设置面板实际可见且滑块可点击', readingPanel.visible && readingPanel.reachable && readingPanel.open, JSON.stringify(readingPanel));
  if (readingPanel.visible && readingPanel.reachable) {
    await click('[data-ezr-setting="bodyFontSize"]', true);
    await click('[data-ezr-setting="capitalizeFirst"]', true);
    state = await status();
    check('鼠标操作设置后字号与开关实际生效', state.settings.bodyFontSize > 16 && state.settings.capitalizeFirst === true);
    const saved = await iso(`chrome.storage.local.get('ezr:settings:byOrigin').then(bag => bag['ezr:settings:byOrigin'][location.origin])`);
    check('设置修改已保存到当前站点', saved.bodyFontSize === state.settings.bodyFontSize && saved.capitalizeFirst === true);
    await click('input[name="ezr-theme"][value="dark"]', true);
    state = await status();
    check('点击配色卡片后深色主题生效', state.settings.theme === 'dark' && await iso(`(function () {
      var sh = document.getElementById('ezr-root').shadowRoot;
      return sh.querySelector('input[value="dark"]').checked && getComputedStyle(sh.querySelector('.ezr-settings')).colorScheme === 'dark';
    })()`));
    await click('.ezr-settings-reset', true);
    state = await status();
    check('恢复默认同时更新设置和配色卡片', state.settings.bodyFontSize === 16 && !state.settings.capitalizeFirst && state.settings.theme === 'light' && await iso(`document.getElementById('ezr-root').shadowRoot.querySelector('input[value="light"]').checked`));
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, page.sessionId);
    await page.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, page.sessionId);
    check('设置面板键盘焦点循环回到关闭按钮', await iso(`document.getElementById('ezr-root').shadowRoot.activeElement.classList.contains('ezr-settings-close')`));
    await click('.ezr-settings-close', true);
  } else {
    await escape();
  }

  await click('.ezr-btn-original', true);
  state = await status();
  const preview = await iso(`(function () {
    var sh = document.getElementById('ezr-root').shadowRoot;
    var r = document.getElementById('source-button').getBoundingClientRect();
    return { label: sh.querySelector('.ezr-btn-original').textContent,
      hidden: getComputedStyle(sh.querySelector('.ezr-body')).display === 'none',
      hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id };
  })()`);
  check('原网页按钮显示网页并保留简洁阅读入口', state.previewing && preview.hidden && preview.label === '简洁阅读');
  check('原文模式不会被透明阅读器遮挡', preview.hit === 'source-button');
  check('原文布局和字体与进入阅读前一致', originalLayout === JSON.stringify(await sourceLayout()));
  await click('.ezr-btn-settings', true);
  await pause();
  const originalPanel = await panelState();
  state = await status();
  check('原网页可打开通用设置而不切换视图，排版控件不可用', originalPanel.open && !originalPanel.visible && state.previewing && await iso("!document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-btn-settings').disabled && document.getElementById('ezr-root').shadowRoot.querySelector('[data-ezr-setting=bodyFontSize]').disabled"));
  await escape();
  state = await status();
  if (!state.previewing) await click('.ezr-btn-original', true);
  await click('#source-button');
  check('原网页按钮和原有事件仍可使用', await page.evaluate('window.fixtureClicks === 1'));
  await page.screenshot({ path: path.join(ARTIFACTS, `${currentSuite}-original.png`) });
  await click('.ezr-btn-original', true);
  state = await status();
  check('返回阅读恢复所选内容', state.active && !state.previewing && (await readerText()).trim() === 'Original alpha.');
  await click('.ezr-btn-original', true);
  await escape();
  state = await status();
  check('原网页按 Esc 保留常驻工具栏', state.active && state.previewing);

  await click('.ezr-btn-pick', true);
  state = await status();
  check('阅读器内选区会露出原网页', state.picking && await iso(`!document.getElementById('ezr-root') || getComputedStyle(document.getElementById('ezr-root')).display === 'none'`));
  check('选区时鼠标命中原网页控件', await iso(`(function () {
    var el = document.getElementById('source-button'), r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
  })()`));
  check('选区时原网页布局和字体不变', originalLayout === JSON.stringify(await sourceLayout()));
  await page.screenshot({ path: path.join(ARTIFACTS, `${currentSuite}-picking.png`) });
  await escape();
  state = await status();
  check('取消重新选区后保留原网页工具栏', state.active && !state.picking && state.previewing);
  check('取消后没有选区遮罩残留', await iso(`!document.querySelector('[data-ezr-pick-overlay]')`));

  await click('.ezr-btn-pick', true);
  await click('#source-link');
  state = await status();
  check('可切换到原网页的另一个区域', state.active && !state.picking && (await readerText()).trim() === 'Original beta.');
  check('选区点击链接不会触发导航', await iso(`location.hash === ''`));
  check('重新选区后两个原区域都完整保留', await intact());
  await click('.ezr-btn-original', true);
  await click('.ezr-btn-pick', true);
  await click('#first', false, 'right');
  state = await status();
  check('原文模式取消选区后仍显示原文', state.active && state.previewing && !state.picking);
  await click('.ezr-btn-close', true);
  check('从原文模式关闭后逐字节还原页面', initialHtml === await iso('document.documentElement.outerHTML'));

  await iso(`window.__ezrSend({ type: 'ezr:pick' })`);
  await escape();
  state = await status();
  check('未进入阅读时 Esc 取消仍保留工具栏', state.active && state.previewing && !state.picking);
  await iso(`window.__ezrSend({ type: 'ezr:pick' })`);
  await click('#first', false, 'right');
  check('右键取消选区后原网页节点保持不变', await intact() && (await status()).previewing);
  await iso(`window.__ezrSend({ type: 'ezr:pick' })`);
  await iso(`window.__ezrSend({ type: 'ezr:close' })`);
  state = await status();
  check('关闭命令也能清理独立选区模式', !state.active && !state.picking && initialHtml === await iso('document.documentElement.outerHTML'));

  const errors = page.console.filter(c => c.level === 'error' || c.level === 'exception');
  check('选区和原文切换无页面异常', errors.length === 0, errors.map(c => c.text).join(' | '));
  page.console.length = 0;
}

async function zoomSnapshot(iso) {
  return iso(`(function () {
    var sh = document.getElementById('ezr-root').shadowRoot;
    var root = sh.querySelector('.ezr-root');
    var art = sh.querySelector('.ezr-article');
    var body = art.parentElement;
    var p = art.querySelector('.ezr-para');
    var cs = getComputedStyle(art);
    return {
      scale: Number(getComputedStyle(root).getPropertyValue('--ezr-scale')),
      textScale: p.getBoundingClientRect().width / parseFloat(getComputedStyle(p).width),
      articleWidth: art.getBoundingClientRect().width,
      measurePx: parseFloat(cs.maxWidth),
      availableWidth: body.clientWidth,
      bodyOverflow: body.scrollWidth > body.clientWidth + 1,
      nestedArticles: art.querySelectorAll('.ezr-article').length,
      label: sh.querySelector('.ezr-zoom-label').textContent,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth
    };
  })()`);
}

async function functionalChecks(page, iso) {
  const readiness = await iso(
    `(function () {
       var sh = __t.shadow();
       var art = sh && sh.querySelector('.ezr-article');
       return {
         constants: !!(window.__ezrK && window.__ezrK.fonts),
         para: !!(art && art.querySelector('.ezr-para'))
       };
     })()`,
  );
  if (!readiness.constants) {
    check('已加载扩展模块常量', false, 'window.__ezrK 缺失');
    return;
  }
  if (!readiness.para) {
    check('存在可测正文段落', false, '没有 .ezr-para');
    return;
  }

  // ---- requirement 2: switchable display font ----
  const fontResult = await iso(`
    (async () => {
      function family() {
        var sh = document.getElementById('ezr-root').shadowRoot;
        var p = sh.querySelector('.ezr-article .ezr-para');
        return getComputedStyle(p).fontFamily;
      }
      var seen = {};
      for (var i = 0; i < window.__ezrK.fonts.length; i++) {
        var f = window.__ezrK.fonts[i];
        await window.__ezrSend({ type: 'ezr:update-settings', patch: { fontId: f.id } });
        await __t.wait(60);
        seen[f.id] = family();
      }
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { fontId: window.__ezrK.defaults.fontId } });
      await __t.wait(60);
      return { seen: seen, fonts: window.__ezrK.fonts };
    })()
  `);
  const firstOf = (stack) => String(stack).split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  const mismatched = fontResult.fonts.filter(
    (f) => !String(fontResult.seen[f.id] || '').toLowerCase().includes(firstOf(f.stack)),
  );
  check(
    `全部 ${fontResult.fonts.length} 个字体族可选且生效`,
    mismatched.length === 0,
    mismatched.length ? mismatched.map((m) => `${m.id}: ${fontResult.seen[m.id]}`).join(' | ') : '全部命中',
  );

  // ---- requirement 4: the paragraph gap is re-derived from the line height ----
  const gapResult = await iso(`
    (async () => {
      function measure() {
        var sh = document.getElementById('ezr-root').shadowRoot;
        var p = sh.querySelectorAll('.ezr-article .ezr-para');
        var lh = __t.measureLineHeight(p[0]);
        var gap = __t.gapBetween(p[0], p[1]);
        return { lh: lh, gap: gap, ratio: gap / lh };
      }
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { lineHeight: 1.4, bodyFontSize: 16 } });
      await __t.wait(120);
      var small = measure();
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { lineHeight: 2.1 } });
      await __t.wait(120);
      var large = measure();
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { lineHeight: 1.3, bodyFontSize: 20 } });
      await __t.wait(120);
      var big = measure();
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { lineHeight: 1.6, bodyFontSize: 16 } });
      await __t.wait(120);
      return { small: small, large: large, big: big };
    })()
  `);
  for (const [label, m] of [
    ['小行距小字号', gapResult.small],
    ['大行距', gapResult.large],
    ['大字号', gapResult.big],
  ]) {
    check(
      `${label}：段间距 > 1.5 倍行高`,
      m.ratio > 1.5,
      `ratio=${m.ratio.toFixed(2)} (L=${m.lh.toFixed(1)} gap=${m.gap.toFixed(1)})`,
    );
  }
  check(
    '段间距随行距自动放大',
    gapResult.large.gap > gapResult.small.gap + 1,
    `${gapResult.small.gap.toFixed(1)}px → ${gapResult.large.gap.toFixed(1)}px`,
  );

  // ---- requirement 3: capitalize the first letter of every word ----
  const caseResult = await iso(`
    (async () => {
      var sh = document.getElementById('ezr-root').shadowRoot;
      // Pick a paragraph with real prose. The first .ezr-para in a paper fixture is the
      // author/affiliation line, which legitimately has almost no markable words.
      var all = sh.querySelectorAll('.ezr-article .ezr-para');
      var target = null;
      var before = '';
      for (var i = 0; i < all.length; i++) {
        var text = __t.textOf(all[i]);
        if ((text.match(/\\s+/g) || []).length >= 12) { target = all[i]; before = text; break; }
      }
      if (!target) return { error: 'no paragraph with >= 12 words' };

      var blockId = target.getAttribute('data-ezr-id');
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { capitalizeFirst: true } });
      await __t.wait(180);
      target = sh.querySelector('[data-ezr-id="' + blockId + '"]');

      var marks = target.querySelectorAll('[data-ezr-w]');
      var texts = Array.prototype.map.call(marks, function (n) { return n.textContent; });
      var tags = {};
      Array.prototype.forEach.call(target.querySelectorAll('*'), function (n) { tags[n.tagName.toLowerCase()] = 1; });
      var after = __t.textOf(target);

      // The uppercase is produced by ::first-letter. Structure is asserted here (only
      // word-marker spans may be injected); the visual effect is asserted separately.
      var injected = Object.keys(tags).filter(function (t) { return t !== 'span' && t !== 'a'; });
      var samples = [];
      Array.prototype.forEach.call(marks, function (mark, i) {
        if (i < 3 && samples.length < 3) {
          samples.push({
            word: mark.textContent.slice(0, 12),
            CSSfirstLetter: getComputedStyle(mark, '::first-letter').textTransform,
            tag: mark.tagName.toLowerCase()
          });
        }
      });
      return {
        samples: samples,
        injected: injected.join(','),
        marks: marks.length,
        maxWordLen: texts.reduce(function (m, s) { return Math.max(m, s.length); }, 0),
        textUnchanged: before === after,
        error: null
      };
    })()
  `);

  const caseChecks = caseResult.samples || [];
  if (caseResult.error) {
    check('找到足够长的正文档落', false, caseResult.error);
  } else {
    check('渲染期大写标记已插入 (>=8 个词)', caseResult.marks >= 8, `${caseResult.marks} 个`);
    check('取到大写渲染采样', caseChecks.length > 0, `${caseChecks.length} 个采样`);
    check(
      '每个单词首字母由 ::first-letter 渲染为大写',
      caseChecks.length > 0 && caseChecks.every((s) => String(s.CSSfirstLetter).includes('uppercase')),
      caseChecks.map((s) => `${s.word}→${s.CSSfirstLetter}`).join(' | ') || 'no samples',
    );
    check(
      '大写只作用于渲染，不改写原文本',
      caseResult.textUnchanged === true,
      caseResult.textUnchanged ? '' : 'text changed',
    );
    check(
      '只插入 span 标记，未污染其它标签',
      (caseResult.injected || '') === '',
      caseResult.injected || 'span/a only',
    );
    check(
      '单个标记不超过一个单词',
      caseResult.maxWordLen > 0 && caseResult.maxWordLen <= 24,
      `最长 ${caseResult.maxWordLen} 字符`,
    );
  }

  // Turning it off must not leave markers behind.
  const offResult = await iso(`
    (async () => {
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { capitalizeFirst: false } });
      await __t.wait(150);
      var sh = document.getElementById('ezr-root').shadowRoot;
      return {
        marks: sh.querySelectorAll('.ezr-article [data-ezr-w]').length,
        anyData: sh.querySelectorAll('.ezr-article [data-ezr-w]').length
      };
    })()
  `);
  check('关闭后包裹标记被清除', offResult.marks === 0, `${offResult.marks} 个残留`);

  // ---- requirement 5: zoom matching ----
  await iso(`window.__ezrSend({ type: 'ezr:update-settings', patch: { zoomMode: 'manual', zoom: 1 } })`);
  await iso('__t.wait(180)');
  const fitPoint = await iso(`(function () {
    var button = __t.shadow().querySelector('.ezr-zoom-fit'), r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.session.send('Input.dispatchMouseEvent', { type, ...fitPoint, button: 'left', clickCount: 1 }, page.sessionId);
  }
  await iso('__t.wait(180)');
  const zoomResult = await zoomSnapshot(iso);
  const expectedWide = Math.max(0.6, Math.min(2.5, zoomResult.availableWidth / zoomResult.measurePx));
  check('点击适配按钮后宽屏按窗口宽度放大正文', zoomResult.scale > 1 && Math.abs(zoomResult.scale - expectedWide) < 0.005, `scale=${zoomResult.scale} expected=${expectedWide}`);
  check('正文只有一层缩放', zoomResult.nestedArticles === 0 && Math.abs(zoomResult.textScale - zoomResult.scale) < 0.01, `textScale=${zoomResult.textScale}`);
  check(
    '适配后正文列宽与阅读窗口可用宽度一致',
    Math.abs(zoomResult.articleWidth - zoomResult.availableWidth) <= 1,
    `article=${zoomResult.articleWidth.toFixed(0)} available=${zoomResult.availableWidth}`,
  );
  check('宽屏适配倍率与百分比同步', zoomResult.label === Math.round(zoomResult.scale * 100) + '%', zoomResult.label);
  check(
    '适配后页面无横向溢出',
    zoomResult.scrollWidth <= zoomResult.clientWidth + 1,
    `scrollWidth=${zoomResult.scrollWidth} clientWidth=${zoomResult.clientWidth}`,
  );

  const manualZoom = await iso(`
    (async () => {
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { zoomMode: 'manual', zoom: 1.35 } });
      await __t.wait(180);
      var sh = document.getElementById('ezr-root').shadowRoot;
      return parseFloat(sh.querySelector('.ezr-root').style.getPropertyValue('--ezr-scale'));
    })()
  `);
  check('手动缩放倍率被应用', Math.abs(manualZoom - 1.35) < 0.02, `scale=${manualZoom}`);
  const manualResult = await zoomSnapshot(iso);
  check('手动 1.35 倍的实际文字尺寸正确', Math.abs(manualResult.textScale - 1.35) < 0.01, `textScale=${manualResult.textScale}`);

  // Resize without changing settings first, then repaint without changing layout.
  // This catches stale width measurements and a cached zoom lost by applyVars().
  await iso(`window.__ezrSend({ type: 'ezr:update-settings', patch: { zoomMode: 'fit-width' } })`);
  await page.setViewport(520, 900);
  await iso('__t.wait(250)');
  const narrow = await zoomSnapshot(iso);
  const expectedNarrow = Math.max(0.6, Math.min(1, narrow.availableWidth / narrow.measurePx));
  check('窄屏按设计列宽自动缩小', narrow.scale < 1 && Math.abs(narrow.scale - expectedNarrow) < 0.005,
    `scale=${narrow.scale.toFixed(4)} expected=${expectedNarrow.toFixed(4)}`);
  check('窄屏正文不溢出阅读区域', !narrow.bodyOverflow && narrow.articleWidth <= narrow.availableWidth + 1,
    `article=${narrow.articleWidth.toFixed(1)} available=${narrow.availableWidth}`);
  check('窄屏实际文字倍率和工具栏同步', Math.abs(narrow.textScale - narrow.scale) < 0.01 && narrow.label === Math.round(narrow.scale * 100) + '%',
    `textScale=${narrow.textScale.toFixed(4)} label=${narrow.label}`);

  await iso(`(async () => {
    await window.__ezrSend({ type: 'ezr:update-settings', patch: { theme: 'sepia' } });
    await __t.wait(180);
  })()`);
  const repainted = await zoomSnapshot(iso);
  check('切换主题后保持窄屏适配倍率', Math.abs(repainted.scale - narrow.scale) < 0.005 && Math.abs(repainted.textScale - narrow.scale) < 0.01 && repainted.label === narrow.label,
    `before=${narrow.scale.toFixed(4)} after=${repainted.scale.toFixed(4)}`);

  await page.setViewport(1280, 900);
  await iso('__t.wait(250)');
  const widened = await zoomSnapshot(iso);
  const widenedExpected = Math.max(0.6, Math.min(2.5, widened.availableWidth / widened.measurePx));
  check('恢复宽屏后重新铺满可用宽度', Math.abs(widened.scale - widenedExpected) < 0.005 && Math.abs(widened.articleWidth - widened.availableWidth) <= 1
    && widened.label === Math.round(widenedExpected * 100) + '%', `scale=${widened.scale}`);

  await iso(`(async () => {
    document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-zoom-in').click();
    await __t.wait(180);
  })()`);
  const stepped = await zoomSnapshot(iso);
  const expectedStep = Math.min(2.5, Number((widened.scale + 0.1).toFixed(2)));
  check('放大按钮从当前适配倍率增加 10%', Math.abs(stepped.scale - expectedStep) < 0.005 && stepped.label === Math.round(expectedStep * 100) + '%', `scale=${stepped.scale}`);

  await iso(`
    (async () => {
      await window.__ezrSend({ type: 'ezr:update-settings', patch: { zoomMode: 'fit-width', zoom: 1, lineHeight: 1.6, bodyFontSize: 16, theme: 'light' } });
      return true;
    })()
  `);
}

/* ------------------------------------------------------------------ utilities */

function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) {
      return `@${i}: …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))} ≠ …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}`;
    }
  }
  return `长度不同 ${a.length} ≠ ${b.length}`;
}

/** Poll a boolean expression in the page until true or the timeout expires. */
async function poll(page, expression, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await iso(expression)) return true;
    } catch {
      /* the page may be mid-navigation */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/* ---------------------------------------------------------------------- main */

async function main() {
  if (!existsSync(path.join(DIST, 'content.js'))) {
    console.error('[test] 找不到 dist/extension/content.js，请先运行: node tools/build.js');
    process.exitCode = 1;
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    console.error('[test] 找不到可用的 Chromium 浏览器（可用 EZR_BROWSER 环境变量指定路径）。');
    process.exitCode = 1;
    return;
  }

  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });

  const { server, names } = await startFixtureServer();
  const missing = Object.values(SUITES)
    .map((s) => s.fixture)
    .filter((f) => !names.includes(f));
  if (missing.length) {
    console.error(`[test] fixtures 缺失: ${missing.join(', ')}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  console.log(`[test] 浏览器: ${browser}`);
  console.log(`[test] 扩展目录: ${DIST}`);
  console.log(`[test] fixture 服务: ${BASE}`);

  const { child, log } = launch(browser);
  let session = null;

  try {
    const version = await waitForEndpoint(PORT_CDP, { timeoutMs: 60000 });
    info(`浏览器版本: ${version.Browser}`);
    session = await CdpSession.connect({ url: version.webSocketDebuggerUrl, port: PORT_CDP });

    const page = await CdpPage.attach(session, { url: 'about:blank' });
    await page.setViewport(1280, 900);

    for (const [name, suite] of Object.entries(SUITES)) {
      if (only && !only.includes(name)) continue;
      currentSuite = name;
      console.log(`\n■ ${name}  (${suite.fixture})`);

      await page.goto(`${BASE}/${suite.fixture}`);

      // The content script runs in an isolated world that shares the page's DOM but not
      // its JS heap, so `window.__ezr` is invisible to a plain main-world evaluate.
      // Find the world that owns the marker and drive everything from there.
      const contextId = await page.findContext('typeof window.__ezr === "object"', { timeoutMs: 25000 });
      if (contextId === null) {
        check('内容脚本已注入', false, '未在 25s 内就绪（扩展可能未加载）');
        await page.screenshot({ path: path.join(ARTIFACTS, `${name}-no-content-script.png`) });
        continue;
      }
      info(`内容脚本已就绪（isolated world #${contextId}）`);

      const iso = (expression) => page.evaluate(expression, { contextId });

      await resetSettings(page, iso);

      if (name === 'toolbar') {
        await toolbarChecks(page, iso, check, ARTIFACTS);
        continue;
      }

      if (name === 'translation') {
        await translationChecks(page, iso, check, ARTIFACTS);
        continue;
      }
      if (name === 'text-translation') {
        await textTranslationChecks(page, iso, check, ARTIFACTS);
        continue;
      }
      if (name === 'full-translation') {
        await fullTranslationChecks(page, iso, check, ARTIFACTS);
        continue;
      }

      if (name.startsWith('interaction')) {
        await interactionChecks(page, iso);
        continue;
      }

      const htmlBefore = await iso('document.documentElement.outerHTML');
      const bodyBefore = await iso('document.body ? document.body.innerHTML.length : 0');

      const started = Date.now();
      const opened = await iso('window.__ezr.open({})');
      const openMs = Date.now() - started;

      if (!opened || !opened.ok) {
        check('打开阅读视图', false, JSON.stringify(opened));
        await page.screenshot({ path: path.join(ARTIFACTS, `${name}-failed.png`) });
        continue;
      }
      check('打开阅读视图', true, `${openMs}ms · ${opened.blocks} 块 · ${opened.chars} 字符`);
      // Check the initial frame BEFORE resetSettings can overwrite its zoom.
      await iso('new Promise(resolve => setTimeout(resolve, 200))');
      const initialZoom = await zoomSnapshot(iso);
      const expectedInitial = Math.max(0.6, Math.min(2.5, initialZoom.availableWidth / initialZoom.measurePx));
      check('首次打开按窗口宽度适配且实际文字倍率一致', Math.abs(initialZoom.scale - expectedInitial) < 0.005 && Math.abs(initialZoom.textScale - expectedInitial) < 0.01,
        `scale=${initialZoom.scale.toFixed(4)} textScale=${initialZoom.textScale.toFixed(4)}`);
      check(
        suite.perf ? '大文档提取耗时 < 1500ms' : '提取耗时 < 800ms',
        openMs < (suite.perf ? 1500 : 800),
        `${openMs}ms`,
      );

      // The harness and the reader's own internals must not hold stale persisted state.
      await resetSettings(page, iso);
      await iso(HARNESS);
      await iso(LOAD_CONSTANTS);

      // Each suite body uses a bare `return` to bail out early when the reader is not
      // mounted, so it must be evaluated as a function body — `Runtime.evaluate`
      // compiles a raw string as a Program, where `return` is a syntax error.
      await iso(`(function () {\n${await suite.build()}\n})()`);
      const report = await iso('__t.report()');
      for (const item of report) check(item.label, item.pass, item.detail);

      await functionalChecks(page, iso);

      if (name === 'paper') {
        const restoredScroll = await iso(`(async () => {
          var sh = document.getElementById('ezr-root').shadowRoot;
          var scroller = sh.querySelector('.ezr-body');
          scroller.scrollTop = 420;
          await __t.wait(120);
          var before = scroller.scrollTop;
          sh.querySelector('.ezr-btn-original').click();
          await __t.wait(120);
          sh.querySelector('.ezr-btn-original').click();
          await __t.wait(120);
          return { before: before, after: scroller.scrollTop };
        })()`);
        check('原文往返保留阅读滚动位置', restoredScroll.before > 0 && Math.abs(restoredScroll.before - restoredScroll.after) < 1,
          `${restoredScroll.before} → ${restoredScroll.after}`);
        await iso(`document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-btn-settings').click()`);
        await page.setViewport(320, 640);
        await iso('new Promise(resolve => setTimeout(resolve, 250))');
        const drawerFits = await iso(`(function () {
          var sh = document.getElementById('ezr-root').shadowRoot;
          var panel = sh.querySelector('.ezr-settings'), scroller = sh.querySelector('.ezr-settings-scroll');
          var r = panel.getBoundingClientRect(), close = sh.querySelector('.ezr-settings-close').getBoundingClientRect();
          var reset = sh.querySelector('.ezr-settings-reset').getBoundingClientRect();
          return r.left >= 0 && r.right <= document.documentElement.clientWidth && scroller.scrollWidth === scroller.clientWidth
            && close.top >= 0 && reset.bottom <= innerHeight && scroller.scrollHeight > scroller.clientHeight;
        })()`);
        check('320px 窄窗口下设置不溢出且关闭与重置保持可见', drawerFits);
        await page.setViewport(1280, 900);
        await page.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page.sessionId);
        const settingsClosed = await iso(`(function () {
          var sh = document.getElementById('ezr-root')?.shadowRoot;
          return !!sh && sh.querySelector('[role="dialog"]')?.getAttribute('aria-hidden') === 'true';
        })()`);
        check('Esc 优先关闭设置面板并保留阅读视图', settingsClosed);
      }

      // ---- exit must restore the document byte-for-byte ----
      await iso('window.__ezr.close()');
      await waitForReaderClosed(page);

      const htmlAfter = await iso('document.documentElement.outerHTML');
      const bodyAfter = await iso('document.body ? document.body.innerHTML.length : 0');
      const readerGone = await iso('!document.getElementById("ezr-root")');

      check('退出后阅读视图已移除', readerGone);
      check(
        '退出后文档逐字节还原',
        htmlBefore === htmlAfter,
        htmlBefore === htmlAfter ? '' : firstDifference(htmlBefore, htmlAfter),
      );
      check('退出后 body 长度还原', Math.abs(bodyAfter - bodyBefore) <= 2, `${bodyBefore} → ${bodyAfter}`);

      const consoleErrors = page.console.filter((c) => c.level === 'error' || c.level === 'exception');
      check('运行期间无页面异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).map((c) => c.text).join(' | '));

      await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
      page.console.length = 0;
    }
  } catch (error) {
    console.error(`\n[test] 执行失败: ${error.message}`);
    console.error(String((error && error.stack) || '').split('\n').slice(0, 12).join('\n'));
    if (log.length) console.error('[test] 浏览器输出（末尾）:\n' + log.join('').split('\n').slice(-15).join('\n'));
    process.exitCode = 1;
  } finally {
    if (session) session.close();
    try {
      if (child.pid) child.kill();
    } catch {
      /* ignore */
    }
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${'='.repeat(76)}`);
  console.log(`合计 ${results.length} 项断言：通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('\n失败明细:');
    for (const f of failed) console.log(`  ✗ [${f.suite}] ${f.label}${f.detail ? `  → ${f.detail}` : ''}`);
    console.log(`\n截图与诊断已写入: ${ARTIFACTS}`);
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log(`全部通过。截图已写入: ${ARTIFACTS}`);
  } else {
    console.log('测试运行中断，未完成的检查不计为通过。');
  }
}

await main();
