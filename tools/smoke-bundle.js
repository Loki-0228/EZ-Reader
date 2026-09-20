/**
 * Bundle smoke test — zero dependencies.
 *
 * The build's `new Function(bundle)` check only proves the bundle PARSES. This runs it
 * for real against a stubbed browser environment, which catches the failure mode that
 * matters most: a bundle that parses, throws on the first line, and therefore leaves the
 * extension looking "not installed" with nothing in the page console.
 *
 * It asserts that content.js boots, registers its debug surface, and leaves the page's
 * mutation helpers untouched during module initialisation.
 *
 * Usage: node tools/smoke-bundle.js
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(ROOT, 'dist', 'extension', 'content.js');

let bundle;
try {
  bundle = readFileSync(bundlePath, 'utf8');
} catch {
  console.error('找不到 dist/extension/content.js，请先运行: node tools/build.js');
  process.exitCode = 1;
}

if (bundle) {
  /* ---------------------------------------------------------------- DOM stub */

  /**
   * Enough of the DOM for module initialisation. The stubs are deliberately inert:
   * anything the reader does at import time would show up as a thrown error here.
   */
  function makeElement(tag = 'div') {
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      nodeName: String(tag).toUpperCase(),
      id: '',
      className: '',
      childNodes: [],
      children: [],
      attributes: {},
      style: {
        setProperty() {},
        getPropertyValue: () => '',
        removeProperty() {},
      },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      dataset: {},
      isConnected: false,
      parentNode: null,
      parentElement: null,
      ownerDocument: null,
      textContent: '',
      innerHTML: '',
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      hasAttribute(name) {
        return Object.hasOwn(this.attributes, name);
      },
      appendChild(child) {
        this.childNodes.push(child);
        this.children.push(child);
        child.parentNode = this;
        child.parentElement = this.nodeType === 1 ? this : null;
        return child;
      },
      append(...nodes) {
        for (const n of nodes) this.appendChild(n);
      },
      insertBefore(child) {
        return this.appendChild(child);
      },
      removeChild(child) {
        this.childNodes = this.childNodes.filter((c) => c !== child);
        this.children = this.children.filter((c) => c !== child);
        return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
      replaceWith() {},
      replaceChildren(...nodes) {
        this.childNodes = [];
        this.children = [];
        for (const n of nodes) this.appendChild(n);
      },
      addEventListener() {},
      removeEventListener() {},
      attachShadow() {
        return makeShadowRoot();
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      scrollIntoView() {},
      contains: () => false,
      checkVisibility: () => true,
    };
    return el;
  }

  function makeShadowRoot() {
    const root = makeElement('shadow-root');
    root.nodeType = 11;
    root.firstChild = null;
    root.shadowRoot = null;
    return root;
  }

  const documentElement = makeElement('html');
  const body = makeElement('body');
  const head = makeElement('head');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  documentElement.isConnected = true;

  const doc = {
    nodeType: 9,
    documentElement,
    body,
    head,
    title: 'Smoke Test Page',
    readyState: 'complete',
    createElement: (tag) => makeElement(tag),
    createElementNS: (_ns, tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), nodeName: '#text', parentNode: null }),
    createDocumentFragment: () => {
      const frag = makeElement('#fragment');
      frag.nodeType = 11;
      return frag;
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    location: { href: 'https://example.com/x', origin: 'https://example.com', protocol: 'https:' },
    baseURI: 'https://example.com/x',
    defaultView: null,
    cookie: '',
  };

  const storageBag = {};
  const chromeStub = {
    runtime: {
      id: 'smoketestextensionid',
      getURL: (p) => `chrome-extension://smoketestextensionid/${p}`,
      getManifest: () => ({ name: 'EZ-Reader', version: '0.1.0' }),
      onMessage: { addListener() {}, removeListener() {} },
      onInstalled: { addListener() {} },
      lastError: null,
    },
    storage: {
      local: {
        get: async (key) => {
          if (key === null || key === undefined) return { ...storageBag };
          if (typeof key === 'string') return Object.hasOwn(storageBag, key) ? { [key]: storageBag[key] } : {};
          return {};
        },
        set: async (items) => {
          Object.assign(storageBag, items);
        },
        remove: async () => {},
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    scripting: { executeScript: async () => [] },
    tabs: { query: async () => [], sendMessage: async () => undefined },
    commands: { onCommand: { addListener() {} } },
  };

  const sandbox = {
    document: doc,
    chrome: chromeStub,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    confirm: () => false,
    alert: () => {},
    location: doc.location,
    navigator: { userAgent: 'smoke-test', language: 'en-US', languages: ['en-US'] },
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      fontSize: '16px',
      lineHeight: '24px',
      fontWeight: '400',
      textAlign: 'left',
      textTransform: 'none',
      overflow: 'visible',
    }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    URL,
    AbortController,
    DOMException,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  doc.defaultView = sandbox;

  /* ------------------------------------------------------------------- run */

  const checks = [];
  const check = (label, passed, detail = '') => {
    checks.push({ label, passed: !!passed, detail });
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? `  → ${detail}` : ''}`);
  };

  let context;
  try {
    context = vm.createContext(sandbox);
    vm.runInContext(bundle, context, { filename: 'content.js', timeout: 10000 });
    check('bundle 在最小浏览器环境下执行成功', true);
  } catch (error) {
    check('bundle 在最小浏览器环境下执行成功', false, error.message);
    console.log(error.stack.split('\n').slice(0, 6).join('\n'));
  }

  if (context) {
    check('内容脚本防重复标记已设置', context.__EZR_CONTENT_LOADED__ === true);
    check('调试接口 __ezr 已注册', typeof context.__ezr === 'object' && context.__ezr !== null);
    check(
      '消息派发器可用 (__ezr.send)',
      typeof context.__ezr?.send === 'function',
    );
    if (typeof context.__ezr?.send === 'function') {
      const status = await Promise.resolve(context.__ezr.send({ type: 'ezr:status' })).catch((error) => ({
        error: String(error && error.message),
      }));
      check('ezr:status 返回结构化响应', !!status && status.ok === true, JSON.stringify(status).slice(0, 140));
      check(
        'status 带回完整设置（默认值已归一化）',
        !!status?.settings && typeof status.settings.bodyFontSize === 'number' && typeof status.settings.fontId === 'string',
        status?.settings ? Object.keys(status.settings).length + ' 个字段' : 'no settings',
      );
      check('status 报告 fontStack', typeof status?.fontStack === 'string' && status.fontStack.length > 0, status?.fontStack);
    }
    check('运行时没有向页面注入节点', documentElement.children.length === 2, `${documentElement.children.length} 个子节点`);
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`bundle 冒烟测试：通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) process.exitCode = 1;
}
