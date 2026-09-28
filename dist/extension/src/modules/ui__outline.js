/**
 * @file 大纲面板：把 heading 块渲染成缩进按钮列表，点击跳转到对应块。
 * 只在传入的容器内渲染与查询。
 */

import { getDoc } from '../dom/env.js';

/** 每个层级增加的缩进（px）。 */
const INDENT_STEP = 14;
/** 基础缩进（px）。 */
const INDENT_BASE = 8;
/** 条目显示的最大字符数。 */
const LABEL_MAX = 48;

/**
 * 截断标题文本。
 * @param {string} text 原文。
 * @param {number} max 最大长度。
 * @returns {string} 截断文本。
 */
function truncate(text, max) {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * 创建大纲面板。
 * @param {HTMLElement|ShadowRoot} container 渲染容器（通常是 `aside.ezr-outline`）。
 * @param {{settings?: Object, onJump?: (blockId: number|string) => void, doc?: Document}} [opts] 选项。
 * @returns {{render: (entries: Array<{id: number|string, level: number, text: string}>) => void,
 *   setOpen: (open: boolean) => void, element: HTMLElement, destroy: () => void}} 句柄。
 */
export function createOutline(container, opts = {}) {
  const doc = opts.doc ?? container?.ownerDocument ?? getDoc();
  let destroyed = false;
  let open = false;
  /** @type {Array<{id: number|string, level: number, text: string}>} */
  let entries = [];

  const head = doc.createElement('div');
  head.className = 'ezr-outline-head';

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ezr-outline-toggle';
  toggle.textContent = '大纲';
  toggle.setAttribute('aria-label', '显示或隐藏文章大纲');
  toggle.setAttribute('title', '显示或隐藏文章大纲');
  toggle.setAttribute('aria-expanded', 'false');
  head.appendChild(toggle);

  const nav = doc.createElement('nav');
  nav.className = 'ezr-outline-list';
  nav.setAttribute('aria-label', '文章大纲');

  const empty = doc.createElement('div');
  empty.className = 'ezr-outline-empty';
  empty.textContent = '本文没有标题';

  container.appendChild(head);
  container.appendChild(nav);
  container.appendChild(empty);

  /** 点击标题：收起大纲（窄屏）并跳转。 @param {number|string} id 块 id。 */
  const jump = (id) => {
    if (typeof opts.onJump === 'function') {
      try {
        opts.onJump(id);
      } catch {
        /* 回调异常不影响大纲 */
      }
    }
  };

  /** 同步显示状态：收起时整块隐藏（由工具栏「大纲」按钮重新展开）。 */
  const sync = () => {
    if (destroyed) return;
    const hasEntries = entries.length > 0;
    container.classList.toggle('is-open', open);
    container.hidden = !open;
    nav.hidden = !open || !hasEntries;
    empty.hidden = !open || hasEntries;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('title', hasEntries ? '显示或隐藏文章大纲' : '本文没有标题');
  };

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    setOpen(!open);
  });

  /**
   * 渲染大纲条目（会清空旧节点，不泄漏监听）。
   * @param {Array<{id: number|string, level: number, text: string}>} list `blocksToOutline(irDoc)` 的结果。
   * @returns {void}
   */
  const render = (list) => {
    if (destroyed) return;
    entries = Array.isArray(list) ? list.filter((e) => e && e.text) : [];
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    for (const entry of entries) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      const level = Number.isFinite(entry.level) ? Math.min(6, Math.max(1, Math.round(entry.level))) : 1;
      const text = truncate(String(entry.text), LABEL_MAX);
      btn.className = `ezr-outline-item ezr-outline-level-${level}`;
      btn.textContent = text;
      btn.setAttribute('aria-label', `${level} 级标题：${text}`);
      btn.setAttribute('title', String(entry.text).replace(/\s+/g, ' ').trim());
      btn.setAttribute('data-ezr-outline-level', String(level));
      btn.style.paddingInlineStart = `${INDENT_BASE + (level - 1) * INDENT_STEP}px`;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        jump(entry.id);
      });
      nav.appendChild(btn);
    }
    sync();
  };

  /**
   * 展开/收起大纲。
   * @param {boolean} next 目标状态。
   * @returns {void}
   */
  const setOpen = (next) => {
    if (destroyed) return;
    open = next === true;
    sync();
  };

  if (opts.settings && opts.settings.showOutline === true) open = true;
  sync();

  /** 移除节点（容器本身归 mount 所有）；幂等。 */
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const node of [head, nav, empty]) {
      try {
        if (node.parentNode) node.parentNode.removeChild(node);
      } catch {
        /* 忽略 */
      }
    }
  };

  return { render, setOpen, element: nav, destroy, get isEmpty() { return entries.length === 0; } };
}
