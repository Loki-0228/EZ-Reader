/**
 * @file Shadow DOM 宿主与整体布局的唯一所有者。
 * 所有 UI 都挂在 `#ezr-root` 的 shadow root 内，页面样式无法影响阅读视图。
 */

import { getDoc } from '../dom/env.js';
import { CSS_VARS, cssVarsFor, readerCss } from '../core/styles.js';

/** 宿主元素 id。 */
const HOST_ID = 'ezr-root';

/** theme 为 auto 时交由 CSS 媒体查询决定的颜色变量。 */
const COLOR_VARS = new Set(['--ezr-fg', '--ezr-bg', '--ezr-muted', '--ezr-border', '--ezr-accent', '--ezr-accent-fg']);

/** readerCss() 不可用时的最小兜底（仍保证 §13 的隔离硬要求）。 */
const FALLBACK_CSS = [
  ':host { all: initial; position: fixed; inset: 0; z-index: 2147483647; }',
  '.ezr-root { line-height: normal; letter-spacing: normal; word-spacing: normal;',
  '  text-transform: none; font-variant: normal; text-align: left; height: 100%; }',
  '@media print { .ezr-toolbar, .ezr-outline { display: none !important } }',
].join('\n');

/**
 * 上一次 mount 的句柄（模块级可变状态，由 mount()/destroy() 显式重置）。
 * @type {{host: Element, shadow: ShadowRoot, abort: () => void, destroy: () => void}|null}
 */
let liveMount = null;

/**
 * 取得完整的阅读器 CSS 文本。
 * @returns {string} CSS 字符串。
 */
function safeReaderCss() {
  try {
    const css = readerCss();
    if (typeof css === 'string' && css.length > 0) return css;
  } catch {
    /* 落到兜底 CSS */
  }
  return FALLBACK_CSS;
}

/**
 * 把设置映射为 `--ezr-*` 自定义属性并写到容器上。
 *
 * `theme: 'auto'` 时颜色交给 `readerCss()` 里的
 * `.ezr-theme-auto` + `prefers-color-scheme` 规则：内联颜色会盖掉那条规则，
 * 所以此时只加类名、不写颜色变量。
 * @param {HTMLElement} root `.ezr-root` 元素。
 * @param {Object} settings 设置对象。
 * @returns {void}
 */
export function applyVars(root, settings) {
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
  const auto = !!settings && settings.theme === 'auto';
  if (root.classList) {
    try {
      root.classList.toggle('ezr-theme-auto', auto);
    } catch {
      /* 忽略 */
    }
  }
  let vars = null;
  try {
    vars = cssVarsFor(settings ?? {});
  } catch {
    vars = null;
  }
  if (!vars || typeof vars !== 'object') return;
  for (const key of CSS_VARS) {
    if (auto && COLOR_VARS.has(key)) {
      // 上一次可能是具体主题：必须清掉内联颜色，否则会盖住 .ezr-theme-auto 的媒体查询。
      try {
        root.style.removeProperty(key);
      } catch {
        /* 忽略 */
      }
      continue;
    }
    const value = vars[key];
    if (value === undefined || value === null) continue;
    try {
      root.style.setProperty(key, String(value));
    } catch {
      /* 单个变量失败不影响其它变量 */
    }
  }
}

/**
 * 创建（或复用）`#ezr-root` 宿主。
 * @param {Document} doc 文档。
 * @param {{host: Element}|null} [previous] 上一次挂载（仍连接时优先复用其宿主）。
 * @returns {Element} 宿主元素。
 */
function ensureHost(doc, previous) {
  if (previous && previous.host && previous.host.isConnected === true) return previous.host;
  let host = null;
  try {
    // 只按本扩展自己的 id 查找：扩展重载后旧宿主可能仍留在 DOM 中。
    if (typeof doc.getElementById === 'function') host = doc.getElementById(HOST_ID);
  } catch {
    host = null;
  }
  if (host && host.isConnected === false) host = null;
  if (!host) {
    const parent = doc.documentElement ?? doc.body;
    if (!parent) throw new Error('ezr/mount: no documentElement');
    host = doc.createElement('div');
    host.id = HOST_ID;
    parent.appendChild(host);
  }
  return host;
}

/**
 * 挂载阅读器外壳。
 * @param {{doc?: Document, settings?: Object, onClose?: Function}} [opts] 选项。
 * @returns {{host: Element, shadow: ShadowRoot, root: HTMLElement, article: HTMLElement,
 *   toolbarHost: HTMLElement, outlineHost: HTMLElement, toastHost: HTMLElement,
 *   setDock: (dock: unknown) => ('top'|'bottom'),
 *   onClose: (Function|undefined), destroy: () => void}} 句柄；`onClose` 为透传，便于调用方复用同一回调。
 */
export function mount(opts = {}) {
  const doc = opts.doc ?? getDoc();

  // 复用仍然连接的宿主：先中止上次挂载的监听，再清空 shadow 重建。
  const previous = liveMount;
  if (previous && previous.host && previous.host.isConnected === true) {
    try {
      previous.abort();
    } catch {
      /* 旧监听已释放 */
    }
  } else if (previous) {
    try {
      previous.destroy();
    } catch {
      /* 旧宿主已断开，忽略 */
    }
  }
  liveMount = null;

  const host = ensureHost(doc, previous);
  let shadow = host.shadowRoot ?? null;
  if (!shadow) {
    try {
      shadow = host.attachShadow({ mode: 'open' });
    } catch {
      shadow = host.shadowRoot ?? null;
    }
  }
  if (!shadow) throw new Error('ezr/mount: shadow root unavailable');
  while (shadow.firstChild) shadow.removeChild(shadow.firstChild);

  const style = doc.createElement('style');
  style.textContent = safeReaderCss();
  shadow.appendChild(style);

  const root = doc.createElement('div');
  root.className = 'ezr-root';

  const toolbarHost = doc.createElement('div');
  toolbarHost.className = 'ezr-toolbar-host';

  const body = doc.createElement('div');
  body.className = 'ezr-body';

  const outlineHost = doc.createElement('aside');
  outlineHost.className = 'ezr-outline';
  outlineHost.setAttribute('aria-label', '文章大纲');
  outlineHost.hidden = true;

  const article = doc.createElement('main');
  article.className = 'ezr-article';

  const toastHost = doc.createElement('div');
  toastHost.className = 'ezr-toast-host';

  body.appendChild(outlineHost);
  body.appendChild(article);
  root.appendChild(toolbarHost);
  root.appendChild(body);
  root.appendChild(toastHost);
  shadow.appendChild(root);

  applyVars(root, opts.settings ?? null);

  /**
   * 将工具栏移动到指定的窗口边缘。
   * DOM 顺序与视觉顺序一致，使键盘 Tab 遍历顺序与停靠位置对应。
   * @param {unknown} dock `'top'` 或 `'bottom'`；其它值按 `'top'` 处理。
   * @returns {'top'|'bottom'} 实际生效的停靠边。
   */
  const setDock = (dock) => {
    const side = dock === 'bottom' ? 'bottom' : 'top';
    try {
      if (side === 'bottom') root.insertBefore(toolbarHost, toastHost);
      else root.insertBefore(toolbarHost, body);
    } catch {
      /* 宿主结构异常时保持当前顺序 */
    }
    try {
      host.setAttribute('data-ezr-dock', side);
    } catch {
      /* 忽略 */
    }
    return side;
  };

  setDock(opts.settings ? opts.settings.toolbarDock : 'top');

  const controller = new AbortController();
  let destroyed = false;

  /** 释放本次挂载的外部监听（不摘除宿主）。 */
  const abort = () => {
    try {
      controller.abort();
    } catch {
      /* 已中止 */
    }
  };

  /** 摘除宿主并释放监听；幂等。 */
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    abort();
    try {
      if (host.parentNode) host.parentNode.removeChild(host);
    } catch {
      /* 宿主已不在文档中 */
    }
    if (liveMount && liveMount.host === host) liveMount = null;
  };

  liveMount = { host, shadow, abort, destroy };

  return {
    host,
    shadow,
    root,
    article,
    toolbarHost,
    outlineHost,
    toastHost,
    setDock,
    signal: controller.signal,
    onClose: opts.onClose,
    destroy,
  };
}
