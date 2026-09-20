/**
 * @file 轻量提示条：单例元素、自动消失、顶部居中，位于 shadow root 内。
 * 任何 DOM 操作都包在 try/catch 中，容器被移除时也不会抛异常。
 */

import { getDoc } from '../dom/env.js';

/** 默认展示时长（ms）。 */
const DEFAULT_DURATION = 3500;
/** 允许的提示类型。 */
const KINDS = Object.freeze(['info', 'warn', 'error']);

/**
 * 创建提示条。
 * @param {HTMLElement|ShadowRoot} container 渲染容器。
 * @param {{duration?: number, doc?: Document}} [opts] 选项。
 * @returns {{show: (message: string, kind?: 'info'|'warn'|'error') => void, destroy: () => void}} 句柄。
 */
export function createToast(container, opts = {}) {
  const doc = opts.doc ?? container?.ownerDocument ?? getDoc();
  const duration = Number.isFinite(opts.duration) ? opts.duration : DEFAULT_DURATION;
  let timer = 0;
  let destroyed = false;

  const el = doc.createElement('div');
  el.className = 'ezr-toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  // 定位机制内联，保证不依赖 readerCss 也始终位于顶部居中且不挡点击。
  Object.assign(el.style, {
    position: 'fixed',
    top: '1.25rem',
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: 'min(32rem, 86vw)',
    padding: '0.5rem 0.9rem',
    borderRadius: '0.4rem',
    background: 'rgba(17, 24, 39, 0.92)',
    color: '#f8fafc',
    fontSize: '14px',
    lineHeight: '1.5',
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.24)',
    pointerEvents: 'none',
    zIndex: '2147483644',
    display: 'none',
  });

  try {
    container.appendChild(el);
  } catch {
    /* 容器不可用时不渲染，但仍可调用 show() */
  }

  /** 隐藏提示条。 */
  const hide = () => {
    if (destroyed) return;
    try {
      el.classList.remove('is-visible');
      el.style.display = 'none';
    } catch {
      /* 忽略 */
    }
  };

  /**
   * 显示一条提示。
   * @param {string} message 文本（应为简体中文）。
   * @param {'info'|'warn'|'error'} [kind='info'] 类型。
   * @returns {void}
   */
  const show = (message, kind = 'info') => {
    if (destroyed) return;
    const type = KINDS.includes(kind) ? kind : 'info';
    try {
      el.textContent = typeof message === 'string' ? message : String(message ?? '');
      el.classList.remove('is-info', 'is-warn', 'is-error');
      el.classList.add(`is-${type}`);
      el.classList.add('is-visible');
      el.style.display = 'block';
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        hide();
      }, duration);
    } catch {
      /* 容器已断开或文档已销毁：静默失败 */
    }
  };

  /** 释放定时器与节点；幂等。 */
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    try {
      if (el.parentNode) el.parentNode.removeChild(el);
    } catch {
      /* 忽略 */
    }
  };

  return { show, destroy };
}
