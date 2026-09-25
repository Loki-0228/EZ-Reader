/**
 * @file 阅读器工具栏：标题碎片、缩放段控、字体快捷选择、首字母大写开关与各功能按钮。
 * 只在自己的容器内构建与查询元素；文档级快捷键监听带 AbortController。
 */

import { FONT_FAMILIES } from '../core/constants.js';
import { getDoc } from '../dom/env.js';
import { closeIcon } from './close-icon.js';

/** 标题碎片最大字符数。 */
const TITLE_MAX = 40;

/**
 * 截断长文本。
 * @param {string} text 原文。
 * @param {number} max 最大长度。
 * @returns {string} 截断后的文本。
 */
function truncate(text, max) {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * 创建工具栏。
 * @param {HTMLElement|ShadowRoot} container 渲染容器（工具栏会被 append 进去）。
 * @param {{settings?: Object, title?: string, doc?: Document, onToggleOutline?: Function,
 *   onPickRegion?: Function, onToggleCapitalize?: Function, onFit?: Function,
 *   onZoom?: (delta: number) => void, onOpenOriginal?: Function, onOpenSettings?: Function,
 *   onClose?: Function, onFontQuick?: (id: string) => void,
 *   onToggleDock?: (dock: 'top'|'bottom') => void,
 *   onFullTranslation?: Function}} [opts] 选项。
 * @returns {{update: (settings: Object) => void, setZoom: (zoom: number) => void,
 *   element: HTMLElement, destroy: () => void}} 句柄；`setZoom` 用于适配模式下同步百分比。
 */
export function createToolbar(container, opts = {}) {
  const doc = opts.doc ?? container?.ownerDocument ?? getDoc();
  const controller = new AbortController();
  let destroyed = false;
  /** @type {Object|null} */
  let current = opts.settings ?? null;
  let reportedZoom = 1;
  let previewing = false;
  /** 读取设置中的停靠边；缺失或非法值默认按顶部处理。 */
  const dockOf = (settings) => (settings && settings.toolbarDock === 'bottom' ? 'bottom' : 'top');

  const bar = doc.createElement('div');
  bar.className = 'ezr-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '阅读工具栏');

  /**
   * 创建按钮。
   * @param {string} text 按钮文字。
   * @param {string} label 无障碍名称。
   * @param {Function|undefined} handler 点击回调。
   * @param {string} [extraClass] 附加类名。
   * @returns {HTMLButtonElement} 按钮元素。
   */
  const makeButton = (text, label, handler, extraClass) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = extraClass ? `ezr-btn ${extraClass}` : 'ezr-btn';
    btn.textContent = text;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      if (btn.disabled) return;
      if (typeof handler === 'function') handler();
    });
    return btn;
  };

  /** 调用回调且吞掉异常，避免一个回调破坏整个 UI。 */
  const fire = (fn, arg) => {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch {
      /* 回调异常不影响工具栏 */
    }
  };

  // 1) 标题碎片
  const titleChip = doc.createElement('span');
  titleChip.className = 'ezr-chip ezr-title-chip';
  const fullTitle = typeof opts.title === 'string' && opts.title
    ? opts.title
    : (doc && typeof doc.title === 'string' ? doc.title : '');
  titleChip.textContent = truncate(fullTitle, TITLE_MAX) || '阅读模式';
  titleChip.setAttribute('title', fullTitle || '阅读模式');
  titleChip.setAttribute('aria-label', `文档标题：${fullTitle || '未命名'}`);
  bar.appendChild(titleChip);

  // 2) 缩放段控
  const zoomGroup = doc.createElement('div');
  zoomGroup.className = 'ezr-zoom';
  zoomGroup.setAttribute('role', 'group');
  zoomGroup.setAttribute('aria-label', '缩放');
  const zoomOutBtn = makeButton('－', '缩小', () => fire(opts.onZoom, -1), 'ezr-zoom-out');
  const zoomFitBtn = makeButton('适配', '缩放正文以适配窗口宽度', () => fire(opts.onFit), 'ezr-zoom-fit');
  const zoomInBtn = makeButton('＋', '放大', () => fire(opts.onZoom, 1), 'ezr-zoom-in');
  const zoomLabel = doc.createElement('span');
  zoomLabel.className = 'ezr-zoom-label';
  zoomLabel.textContent = '100%';
  zoomLabel.setAttribute('aria-label', '当前缩放');
  zoomLabel.setAttribute('title', '当前缩放');
  zoomGroup.appendChild(zoomOutBtn);
  zoomGroup.appendChild(zoomFitBtn);
  zoomGroup.appendChild(zoomInBtn);
  zoomGroup.appendChild(zoomLabel);
  bar.appendChild(zoomGroup);

  // 3) 字体快捷选择
  const fontLabel = doc.createElement('label');
  fontLabel.className = 'ezr-field ezr-font-field';
  const fontText = doc.createElement('span');
  fontText.className = 'ezr-field-label';
  fontText.textContent = '字体';
  const fontSelect = doc.createElement('select');
  fontSelect.className = 'ezr-select ezr-font-select';
  fontSelect.setAttribute('aria-label', '正文字体');
  fontSelect.setAttribute('title', '正文字体');
  for (const family of FONT_FAMILIES) {
    const option = doc.createElement('option');
    option.value = family.id;
    option.textContent = family.label;
    fontSelect.appendChild(option);
  }
  fontSelect.addEventListener('change', () => { if (!fontSelect.disabled) fire(opts.onFontQuick, fontSelect.value); });
  fontLabel.appendChild(fontText);
  fontLabel.appendChild(fontSelect);
  bar.appendChild(fontLabel);

  // 4) 首字母大写开关
  const capsBtn = makeButton('大写首字母', '切换每个单词首字母大写', () => {
    const next = !(current && current.capitalizeFirst === true);
    fire(opts.onToggleCapitalize, next);
  }, 'ezr-toggle-caps');
  capsBtn.setAttribute('aria-pressed', 'false');
  bar.appendChild(capsBtn);

  // 5) 功能按钮
  bar.appendChild(makeButton('大纲', '显示或隐藏文章大纲', () => fire(opts.onToggleOutline), 'ezr-btn-outline'));
  const pickBtn = makeButton('选择区域', '在原网页选择要阅读的区域', () => fire(opts.onPickRegion), 'ezr-btn-pick');
  bar.appendChild(makeButton('设置', '打开设置', () => fire(opts.onOpenSettings), 'ezr-btn-settings'));
  const translationBtn = makeButton('翻译工具', '展开或收起翻译工具栏', () => fire(opts.onFullTranslation), 'ezr-btn-translation');
  translationBtn.setAttribute('aria-expanded', 'false');
  translationBtn.setAttribute('aria-controls', 'ezr-translation-bar');
  bar.appendChild(translationBtn);
  const originalBtn = makeButton('原网页', '查看原网页排版，可使用全文翻译', () => fire(opts.onOpenOriginal), 'ezr-btn-original');
  originalBtn.setAttribute('aria-pressed', 'false');
  const readingGroup = doc.createElement('div');
  readingGroup.className = 'ezr-reading-actions';
  readingGroup.setAttribute('role', 'group');
  readingGroup.setAttribute('aria-label', '阅读与选区');
  readingGroup.append(originalBtn, pickBtn);
  const close = makeButton('', '关闭主工具栏', () => fire(opts.onClose), 'ezr-btn-close ezr-toolbar-close');
  close.appendChild(closeIcon(doc));

  // 6) 停靠按钮位于按钮组末端，关闭图标独立放在最右侧。
  const dockBtn = makeButton('移到底部', '把工具栏停靠到窗口底部', () => {
    fire(opts.onToggleDock, dockOf(current) === 'bottom' ? 'top' : 'bottom');
  }, 'ezr-btn-dock');
  dockBtn.setAttribute('aria-pressed', 'false');
  bar.appendChild(dockBtn);

  bar.insertBefore(readingGroup, zoomGroup);

  const actions = doc.createElement('div'); actions.className = 'ezr-toolbar-actions';
  for (const child of [...bar.children]) if (child !== titleChip) actions.appendChild(child);
  bar.append(actions, close);
  container.appendChild(bar);

  /**
   * 同步界面状态（不重建 DOM）。
   * @param {Object} settings 最新设置。
   * @returns {void}
   */
  const update = (settings) => {
    if (destroyed || !settings) return;
    current = settings;
    zoomFitBtn.setAttribute('aria-pressed', String(settings.zoomMode === 'fit-width'));
    const fontId = typeof settings.fontId === 'string' ? settings.fontId : '';
    if (fontId && fontSelect.value !== fontId) {
      let exists = false;
      for (const option of fontSelect.options) {
        if (option.value === fontId) {
          exists = true;
          break;
        }
      }
      if (exists) fontSelect.value = fontId;
    }
    const capsOn = settings.capitalizeFirst === true;
    capsBtn.setAttribute('aria-pressed', capsOn ? 'true' : 'false');
    capsBtn.classList.toggle('is-on', capsOn);
    const atBottom = dockOf(settings) === 'bottom';
    const dockLabel = atBottom ? '把工具栏停靠到窗口顶部' : '把工具栏停靠到窗口底部';
    dockBtn.textContent = atBottom ? '移到顶部' : '移到底部';
    dockBtn.setAttribute('aria-label', dockLabel);
    dockBtn.setAttribute('title', dockLabel);
    dockBtn.setAttribute('aria-pressed', String(atBottom));
    dockBtn.classList.toggle('is-on', atBottom);
    if (Number.isFinite(settings.zoom)) {
      reportedZoom = settings.zoom;
      zoomLabel.textContent = previewing ? '—' : `${Math.round(settings.zoom * 100)}%`;
    }
  };

  /**
   * 更新缩放百分比显示（适配模式下由 zoom watcher 提供）。
   * @param {number} zoom 当前缩放倍率。
   * @returns {void}
   */
  const setZoom = (zoom) => {
    if (destroyed || !Number.isFinite(zoom)) return;
    reportedZoom = zoom;
    zoomLabel.textContent = previewing ? '—' : `${Math.round(zoom * 100)}%`;
  };

  const setPreviewing = (value) => {
    previewing = !!value;
    originalBtn.textContent = previewing ? '简洁阅读' : opts.isPdf ? 'PDF 原文' : '原网页';
    originalBtn.setAttribute('aria-pressed', String(!!previewing));
    originalBtn.setAttribute('aria-label', previewing ? '切换到简洁阅读' : opts.isPdf ? '返回 PDF 原文排版' : '查看原网页排版，可使用全文翻译');
    originalBtn.setAttribute('title', previewing ? '切换到简洁阅读' : opts.isPdf ? '返回 PDF 原文排版' : '查看原网页排版，可使用全文翻译');
    for (const element of [zoomOutBtn, zoomFitBtn, zoomInBtn, fontSelect, bar.querySelector('.ezr-btn-outline')]) {
      element.disabled = previewing;
      element.title = previewing ? '仅在简洁阅读视图中可用' : element.getAttribute('aria-label');
    }
    const pick = bar.querySelector('.ezr-btn-pick');
    pick.hidden = !!opts.isPdf;
    readingGroup.classList.toggle('ezr-reading-pdf', !!opts.isPdf);
    capsBtn.disabled = !!opts.isPdf && previewing;
    capsBtn.title = capsBtn.disabled ? 'PDF 原文保留原排版，文字样式可在简洁阅读中调整' : capsBtn.getAttribute('aria-label');
    pick.disabled = !previewing || !!opts.isPdf;
    pick.title = previewing ? '在原网页选择要阅读的区域' : '请先切换到原网页，再选择区域';
    zoomLabel.textContent = previewing ? '—' : `${Math.round(reportedZoom * 100)}%`;
    bar.dataset.view = previewing ? 'original' : 'reader';
  };

  /**
   * 文档级快捷键：Alt+Shift+S 选区、Alt+Shift+Z 适配、Esc 关闭。
   * @param {KeyboardEvent} event 键盘事件。
   * @returns {void}
   */
  const onKeyDown = (event) => {
    if (destroyed || bar.hidden) return;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    const code = typeof event.code === 'string' ? event.code : '';
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (code === 'KeyS' || key === 's') {
        event.preventDefault();
        if (previewing && !opts.isPdf) fire(opts.onPickRegion);
        return;
      }
      if (code === 'KeyZ' || key === 'z') {
        event.preventDefault();
        if (!previewing) fire(opts.onFit);
        return;
      }
    }
    // Escape belongs to the active picker, settings panel or reader session.
  };

  try {
    doc.addEventListener('keydown', onKeyDown, { capture: true, signal: controller.signal });
  } catch {
    /* 缺少 addEventListener 的 stub 环境 */
  }

  if (current) update(current);
  setPreviewing(false);

  /** 释放监听并移除工具栏；幂等。 */
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      controller.abort();
    } catch {
      /* 已中止 */
    }
    try {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    } catch {
      /* 忽略 */
    }
  };

  return { update, setZoom, setPreviewing, setTranslationOpen(value) { translationBtn.setAttribute('aria-expanded', String(value)); }, element: bar, destroy, get zoom() { return reportedZoom; } };
}
