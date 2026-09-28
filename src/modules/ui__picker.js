/**
 * @file 选区模式：鼠标悬停高亮页面区域，点击即选中该元素作为提取根。
 * 只读取页面（elementFromPoint + getBoundingClientRect），不修改页面 DOM；
 * 所有监听都挂在 doc 上并带 AbortController，取消/销毁时全部释放。
 */

import { getDoc } from '../dom/env.js';

/** 高亮框 z-index：仅低于阅读器工具栏。 */
const HOVER_Z = 2147483646;
/** 光标样式只注入到 shadow root 内。 */
const CURSOR_CSS = [
  ':host(.ezr-picking), :host(.ezr-picking) *,',
  '.ezr-picking, .ezr-picking * { cursor: crosshair !important; }',
].join('\n');

/**
 * 创建选区选择器。
 * @param {{doc?: Document, onPick?: (el: Element) => void, onCancel?: () => void,
 *   overlayHost?: (Element|ShadowRoot|null)}} [opts] 选项。
 *   `overlayHost` 是高亮框的挂载点（通常是 shadow root 或其中的容器）。
 * @returns {{start: () => void, cancel: () => void, isActive: boolean, destroy: () => void}} 句柄。
 */
export function createPicker(opts = {}) {
  const overlayHost = opts.overlayHost ?? null;
  const doc = opts.doc ?? (overlayHost && overlayHost.ownerDocument) ?? getDoc();

  let active = false;
  let destroyed = false;
  /** @type {AbortController|null} */
  let controller = null;
  /** @type {HTMLElement|null} */
  let box = null;
  /** @type {HTMLElement|null} */
  let label = null;
  /** @type {Element|null} */
  let cursorStyle = null;
  /** @type {Element|null} */
  let cursorTarget = null;
  /** @type {Element|null} */
  let hovered = null;

  /**
   * 光标样式元素只注入一次，且只注入到 shadow root 内。
   * @returns {void}
   */
  const ensureCursorStyle = () => {
    if (cursorStyle && cursorStyle.isConnected !== false) return;
    const root = overlayHost && typeof overlayHost.querySelector === 'function'
      ? overlayHost
      : null;
    if (!root) return;
    try {
      cursorTarget = root.querySelector('.ezr-root');
    } catch {
      cursorTarget = null;
    }
    try {
      cursorStyle = doc.createElement('style');
      cursorStyle.textContent = CURSOR_CSS;
      overlayHost.appendChild(cursorStyle);
    } catch {
      cursorStyle = null;
    }
  };

  /**
   * 创建高亮框与浮动标签。
   * @returns {void}
   */
  const ensureNodes = () => {
    if (!overlayHost || typeof overlayHost.appendChild !== 'function') return;
    if (!box) {
      box = doc.createElement('div');
      box.className = 'ezr-hover-box';
      box.setAttribute('aria-hidden', 'true');
      Object.assign(box.style, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        width: '0px',
        height: '0px',
        border: '2px dashed #4c8dff',
        background: 'rgba(76, 141, 255, 0.14)',
        borderRadius: '2px',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        zIndex: String(HOVER_Z),
        display: 'none',
      });
      overlayHost.appendChild(box);
    }
    if (!label) {
      label = doc.createElement('div');
      label.className = 'ezr-hover-label';
      label.setAttribute('aria-hidden', 'true');
      Object.assign(label.style, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        maxWidth: '60vw',
        padding: '2px 6px',
        border: '1px solid #4c8dff',
        borderRadius: '3px',
        background: 'rgba(17, 24, 39, 0.92)',
        color: '#f8fafc',
        font: '500 12px/1.4 system-ui, sans-serif',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        pointerEvents: 'none',
        boxSizing: 'border-box',
        zIndex: String(HOVER_Z),
        display: 'none',
      });
      overlayHost.appendChild(label);
    }
  };

  /**
   * 取光标下的元素；命中阅读器自身时返回 null。
   * @param {number} x 视口 x。
   * @param {number} y 视口 y。
   * @returns {Element|null} 目标元素。
   */
  const targetAt = (x, y) => {
    let el = null;
    try {
      el = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : null;
    } catch {
      el = null;
    }
    if (!el || el.nodeType !== 1) return null;
    try {
      if (el.closest && el.closest('#ezr-root, [data-ezr-pick-overlay], [data-ezr-toast]')) return null;
      // Clicking emphasis or a link should select its surrounding paragraph.
      while (el.parentElement && /^inline(?:$|-)/.test(doc.defaultView.getComputedStyle(el).display)) {
        el = el.parentElement;
      }
    } catch {
      /* closest 失败时按普通元素处理 */
    }
    return el;
  };

  /**
   * 把高亮框与标签移动到目标元素上。
   * @param {Element|null} el 目标元素。
   * @returns {void}
   */
  const paint = (el) => {
    if (!box || !label) return;
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      box.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    let rect = null;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      rect = null;
    }
    if (!rect) {
      box.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    Object.assign(box.style, {
      display: 'block',
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: `${Math.round(rect.width)}px`,
      height: `${Math.round(rect.height)}px`,
    });
    const tag = el.tagName ? String(el.tagName).toLowerCase() : '区域';
    const length = typeof el.textContent === 'string' ? el.textContent.replace(/\s+/g, ' ').trim().length : 0;
    label.textContent = `<${tag}> · ${length} 字`;
    const labelTop = rect.top > 26 ? rect.top - 24 : rect.bottom + 4;
    Object.assign(label.style, {
      display: 'block',
      left: `${Math.round(Math.max(4, rect.left))}px`,
      top: `${Math.round(Math.max(4, labelTop))}px`,
    });
  };

  /**
   * 重新绘制当前悬停元素（滚动/缩放时用）。
   * @returns {void}
   */
  const repaintHovered = () => {
    if (!active) return;
    if (hovered && hovered.isConnected === false) hovered = null;
    paint(hovered);
  };

  /** 释放监听与视觉元素。 */
  const teardown = () => {
    active = false;
    hovered = null;
    if (controller) {
      try {
        controller.abort();
      } catch {
        /* 已中止 */
      }
      controller = null;
    }
    if (cursorTarget) {
      try {
        cursorTarget.classList.remove('ezr-picking');
      } catch {
        /* 元素已移除 */
      }
    }
    cursorTarget = null;
    if (box) {
      try {
        if (box.parentNode) box.parentNode.removeChild(box);
      } catch {
        /* 忽略 */
      }
      box = null;
    }
    if (label) {
      try {
        if (label.parentNode) label.parentNode.removeChild(label);
      } catch {
        /* 忽略 */
      }
      label = null;
    }
  };

  /** @param {MouseEvent} event 鼠标移动事件。 */
  const onMove = (event) => {
    if (!active) return;
    const el = targetAt(event.clientX, event.clientY);
    hovered = el;
    paint(el);
  };

  /** @param {Event} event 点击事件（捕获阶段拦截）。 */
  const onClick = (event) => {
    if (!active) return;
    const el = targetAt(event.clientX, event.clientY) ?? hovered;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    if (!el) return;
    teardown();
    if (typeof opts.onPick === 'function') {
      try {
        opts.onPick(el);
      } catch {
        /* 回调异常不影响选择器状态 */
      }
    }
  };

  /** @param {MouseEvent} event 右键事件 → 取消。 */
  const onContextMenu = (event) => {
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    cancel();
  };

  /** @param {KeyboardEvent} event 键盘事件（Esc → 取消）。 */
  const onKeyDown = (event) => {
    if (!active) return;
    if (event.key === 'Escape' || event.key === 'Esc') {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      cancel();
    }
  };

  /** 滚动/改变视口时重新对齐高亮框。 */
  const onViewportChange = () => {
    repaintHovered();
  };

  /** 开始选择。 */
  const start = () => {
    if (destroyed || active) return;
    active = true;
    hovered = null;
    ensureCursorStyle();
    ensureNodes();
    if (cursorTarget) {
      try {
        cursorTarget.classList.add('ezr-picking');
      } catch {
        /* 忽略 */
      }
    }
    controller = new AbortController();
    const { signal } = controller;
    doc.addEventListener('mousemove', onMove, { capture: true, passive: true, signal });
    doc.addEventListener('click', onClick, { capture: true, signal });
    doc.addEventListener('contextmenu', onContextMenu, { capture: true, signal });
    doc.addEventListener('keydown', onKeyDown, { capture: true, signal });
    doc.addEventListener('scroll', onViewportChange, { capture: true, passive: true, signal });
    doc.addEventListener('resize', onViewportChange, { capture: true, passive: true, signal });
  };

  /** 取消选择（会触发 onCancel）。 */
  const cancel = () => {
    if (!active) return;
    teardown();
    if (typeof opts.onCancel === 'function') {
      try {
        opts.onCancel();
      } catch {
        /* 回调异常不影响状态 */
      }
    }
  };

  /** 彻底销毁：释放监听与节点，不触发任何回调。 */
  const destroy = () => {
    if (destroyed) return;
    teardown();
    destroyed = true;
    if (box) {
      try {
        if (box.parentNode) box.parentNode.removeChild(box);
      } catch {
        /* 忽略 */
      }
      box = null;
    }
    if (label) {
      try {
        if (label.parentNode) label.parentNode.removeChild(label);
      } catch {
        /* 忽略 */
      }
      label = null;
    }
    if (cursorStyle) {
      try {
        if (cursorStyle.parentNode) cursorStyle.parentNode.removeChild(cursorStyle);
      } catch {
        /* 忽略 */
      }
      cursorStyle = null;
    }
  };

  return {
    start,
    cancel,
    get isActive() {
      return active;
    },
    destroy,
  };
}
