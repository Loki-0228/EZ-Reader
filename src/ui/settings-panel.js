/**
 * @file 阅读设置面板（Shadow DOM 内的右侧抽屉）。
 * 所有数值都用 core/constants.js 的 clamp + SETTING_LIMITS 夹取；
 * 拖动滑块时先即时刷新读数，再以 ~80ms 的节流回调 onChange，保证正文实时更新又不刷屏。
 */

import { FONT_FAMILIES, SETTING_LIMITS, clamp } from '../core/constants.js';
import { getDoc } from '../dom/env.js';
import { createTranslationSettings } from './translation-settings.js';

/** 滑块回调节流间隔（ms）。 */
const DEBOUNCE_MS = 80;

/** 面板定位等「机制性」内联样式：保证不依赖 readerCss 也能正确滑入/收起。 */
const PANEL_MECHANICS = Object.freeze({
  position: 'fixed',
  top: '0px',
  right: '0px',
  bottom: '0px',
  width: '380px',
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '0',
  overflow: 'hidden',
  background: 'var(--ezr-bg, #ffffff)',
  color: 'var(--ezr-fg, #111827)',
  borderLeft: '1px solid var(--ezr-border, rgba(0, 0, 0, 0.16))',
  boxShadow: '-12px 0 28px rgba(0, 0, 0, 0.18)',
  transform: 'none',
  zIndex: '2147483645',
  pointerEvents: 'auto',
});

/** 标题识别强度选项。 */
const HEADING_MODES = Object.freeze([
  { value: 'conservative', label: '保守' },
  { value: 'standard', label: '标准' },
  { value: 'aggressive', label: '激进' },
]);

/** 缩放模式选项。 */
const ZOOM_MODES = Object.freeze([
  { value: 'fit-width', label: '适配宽度' },
  { value: 'fit-page', label: '适配页' },
  { value: 'manual', label: '手动' },
]);

/** 配色选项。 */
const THEMES = Object.freeze([
  { value: 'light', label: '浅色' },
  { value: 'sepia', label: '米色' },
  { value: 'dark', label: '深色' },
  { value: 'auto', label: '跟随系统' },
]);

/**
 * 创建设置面板。
 * @param {HTMLElement|ShadowRoot} container 渲染容器（通常是 shadow root 或 `.ezr-root`）。
 * @param {{settings?: Object, onChange?: (partial: Object) => void, onReset?: () => void,
 *   doc?: Document}} [opts] 选项。
 * @returns {{open: () => void, close: () => void, toggle: () => void,
 *   update: (settings: Object) => void, isOpen: boolean, element: HTMLElement,
 *   destroy: () => void}} 句柄。
 */
export function createSettingsPanel(container, opts = {}) {
  const doc = opts.doc ?? container?.ownerDocument ?? getDoc();
  let destroyed = false;
  let open = false;
  let previewing = !!opts.previewing;
  /** @type {Object|null} */
  let pending = null;
  let timer = 0;
  /** @type {Array<(settings: Object) => void>} */
  const syncers = [];

  const panel = doc.createElement('div');
  panel.className = 'ezr-settings';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '设置');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-hidden', 'true');
  panel.hidden = true;
  let previousFocus = null;
  Object.assign(panel.style, PANEL_MECHANICS);
  if ('inert' in panel) panel.inert = true;

  /** @param {string} tag 标签名。 @param {string} cls 类名。 @param {string} [text] 文本。 */
  const make = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const backdrop = make('div', 'ezr-settings-backdrop');
  backdrop.hidden = true;
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.addEventListener('click', () => close());

  /** 触发 onChange（立即，用于下拉/勾选框/按钮）。 @param {Object} partial 变更。 */
  const emit = (partial) => {
    if (destroyed || !partial) return;
    if (previewing && Object.keys(partial).some(key => !['theme', 'capitalizeFirst', 'rememberPerSite'].includes(key))) return;
    if (typeof opts.onChange !== 'function') return;
    try {
      opts.onChange(partial);
    } catch {
      /* 回调异常不影响面板 */
    }
  };

  /** 立即冲刷累积的滑块变更。 */
  const flush = () => {
    const payload = pending;
    pending = null;
    if (payload) emit(payload);
  };

  /**
   * 节流提交滑块变更：首次立即生效，之后每 ~80ms 合并一次。
   * @param {Object} partial 变更。
   */
  const schedule = (partial) => {
    if (destroyed) return;
    pending = pending ? { ...pending, ...partial } : { ...partial };
    if (timer) return;
    flush();
    timer = setTimeout(() => {
      timer = 0;
      flush();
    }, DEBOUNCE_MS);
  };

  // 头部
  const head = make('div', 'ezr-settings-head');
  const heading = make('div', 'ezr-settings-heading');
  heading.appendChild(make('span', 'ezr-settings-kicker', 'EZ-READER'));
  heading.appendChild(make('h2', 'ezr-settings-title', '设置'));
  const description = make('p', 'ezr-settings-description', '让文字适合你的阅读节奏。');
  heading.appendChild(description);
  head.appendChild(heading);
  const closeBtn = make('button', 'ezr-btn ezr-settings-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭设置');
  closeBtn.setAttribute('title', '关闭设置');
  closeBtn.addEventListener('click', (event) => {
    event.preventDefault();
    close();
  });
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const scroll = make('div', 'ezr-settings-scroll');
  panel.appendChild(scroll);
  const section = (number, title) => {
    const group = make('section', 'ezr-settings-section');
    const label = make('h3', 'ezr-settings-section-title');
    label.appendChild(make('span', 'ezr-section-number', number));
    label.appendChild(make('span', '', title));
    group.appendChild(label);
    scroll.appendChild(group);
    return group;
  };

  /**
   * 生成一行「标签 + 控件」。
   * @param {string} labelText 标签文字。
   * @param {HTMLElement} control 控件。
   * @param {string} [extraClass] 附加类名。
   * @returns {HTMLElement} 行容器（`label`）。
   */
  const row = (labelText, control, extraClass) => {
    const wrap = make('label', extraClass ? `ezr-field ${extraClass}` : 'ezr-field');
    wrap.appendChild(make('span', 'ezr-field-label', labelText));
    wrap.appendChild(control);
    return wrap;
  };

  /**
   * 生成滑块行（带实时读数）。
   * @param {{key: string, label: string, min: number, max: number, step: number,
   *   format: (v: number) => string}} cfg 配置。
   * @returns {HTMLElement} 行容器。
   */
  const rangeRow = (cfg) => {
    const input = make('input', 'ezr-range');
    input.type = 'range';
    input.min = String(cfg.min);
    input.max = String(cfg.max);
    input.step = String(cfg.step);
    input.value = String(cfg.min);
    input.setAttribute('aria-label', cfg.label);
    input.setAttribute('title', cfg.label);
    input.setAttribute('data-ezr-setting', cfg.key);
    const out = make('output', 'ezr-readout', cfg.format(cfg.min));
    input.addEventListener('input', () => {
      const raw = parseFloat(input.value);
      const value = Number.isFinite(raw) ? clamp(raw, cfg.min, cfg.max) : cfg.min;
      out.textContent = cfg.format(value);
      schedule({ [cfg.key]: value });
    });
    const wrap = make('label', 'ezr-field ezr-range-field');
    const heading = make('span', 'ezr-range-heading');
    heading.appendChild(make('span', 'ezr-field-label', cfg.label));
    heading.appendChild(out);
    wrap.appendChild(heading);
    wrap.appendChild(input);
    const limits = make('span', 'ezr-range-limits');
    limits.setAttribute('aria-hidden', 'true');
    limits.appendChild(make('span', '', cfg.format(cfg.min)));
    limits.appendChild(make('span', '', cfg.format(cfg.max)));
    wrap.appendChild(limits);
    const paintTrack = (value) => input.style.setProperty('--ezr-range-fill', `${(value - cfg.min) / (cfg.max - cfg.min) * 100}%`);
    input.addEventListener('input', () => paintTrack(Number(input.value)));
    syncers.push((settings) => {
      const raw = Number(settings ? settings[cfg.key] : NaN);
      const value = Number.isFinite(raw) ? clamp(raw, cfg.min, cfg.max) : cfg.min;
      input.value = String(value);
      out.textContent = cfg.format(value);
      paintTrack(value);
    });
    return wrap;
  };

  /**
   * 生成下拉行。
   * @param {{key: string, label: string, options: ReadonlyArray<{value: string, label: string}>}} cfg 配置。
   * @returns {HTMLElement} 行容器。
   */
  const selectRow = (cfg) => {
    const select = make('select', 'ezr-select');
    select.setAttribute('aria-label', cfg.label);
    select.setAttribute('title', cfg.label);
    select.setAttribute('data-ezr-setting', cfg.key);
    for (const option of cfg.options) {
      const node = make('option', '', option.label);
      node.value = option.value;
      select.appendChild(node);
    }
    select.addEventListener('change', () => emit({ [cfg.key]: select.value }));
    syncers.push((settings) => {
      const value = settings ? settings[cfg.key] : null;
      if (typeof value === 'string') select.value = value;
    });
    return row(cfg.label, select);
  };

  /**
   * 生成勾选行。
   * @param {{key: string, label: string, description: string}} cfg 配置。
   * @returns {HTMLElement} 行容器。
   */
  const checkRow = (cfg) => {
    const input = make('input', 'ezr-check');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', cfg.label);
    input.setAttribute('title', cfg.label);
    input.setAttribute('data-ezr-setting', cfg.key);
    input.addEventListener('change', () => emit({ [cfg.key]: input.checked === true }));
    const wrap = make('label', 'ezr-field ezr-field-check');
    const text = make('span', 'ezr-switch-copy');
    text.appendChild(make('span', 'ezr-field-label', cfg.label));
    text.appendChild(make('span', 'ezr-field-description', cfg.description));
    wrap.appendChild(text);
    wrap.appendChild(input);
    syncers.push((settings) => {
      input.checked = !!(settings && settings[cfg.key] === true);
    });
    return wrap;
  };

  // 排版
  const typography = section('01', '字体与排版');
  typography.appendChild(selectRow({
    key: 'fontId',
    label: '字体',
    options: FONT_FAMILIES.map((f) => ({ value: f.id, label: f.label })),
  }));

  typography.appendChild(rangeRow({
    key: 'bodyFontSize',
    label: '正文字号',
    min: SETTING_LIMITS.bodyFontSize.min,
    max: SETTING_LIMITS.bodyFontSize.max,
    step: 1,
    format: (v) => `${Math.round(v)}px`,
  }));
  typography.appendChild(rangeRow({
    key: 'lineHeight',
    label: '行高',
    min: SETTING_LIMITS.lineHeight.min,
    max: SETTING_LIMITS.lineHeight.max,
    step: 0.05,
    format: (v) => v.toFixed(2),
  }));

  const gapRow = rangeRow({
    key: 'gapFactor',
    label: '段间距',
    min: SETTING_LIMITS.gapFactor.min,
    max: SETTING_LIMITS.gapFactor.max,
    step: 0.05,
    format: (v) => `${v.toFixed(2)} ×行高`,
  });
  const gapReset = make('button', 'ezr-btn ezr-gap-reset', '恢复自动间距');
  gapReset.type = 'button';
  gapReset.setAttribute('aria-label', '恢复自动段间距');
  gapReset.setAttribute('title', '根据当前字号和行高自动计算段间距');
  gapReset.addEventListener('click', (event) => {
    event.preventDefault();
    emit({ gapOverridePx: null });
  });
  typography.appendChild(gapRow);
  typography.appendChild(gapReset);

  typography.appendChild(rangeRow({
    key: 'measure',
    label: '列宽',
    min: SETTING_LIMITS.measure.min,
    max: SETTING_LIMITS.measure.max,
    step: 1,
    format: (v) => `${Math.round(v)}rem`,
  }));

  // 内容
  const content = section('02', '内容处理');
  content.appendChild(checkRow({ key: 'splitLines', label: '自动拆分长段', description: '将挤在一起的文本分成清晰段落' }));
  content.appendChild(selectRow({ key: 'headingMode', label: '标题识别', options: HEADING_MODES }));

  // 视图
  const display = section('03', '显示');
  const zoomField = selectRow({ key: 'zoomMode', label: '缩放模式', options: ZOOM_MODES });
  display.appendChild(zoomField);
  const themeField = make('div', 'ezr-field');
  themeField.appendChild(make('span', 'ezr-field-label', '界面配色'));
  const themeGrid = make('div', 'ezr-theme-grid');
  themeGrid.setAttribute('role', 'radiogroup');
  themeGrid.setAttribute('aria-label', '界面配色');
  for (const theme of THEMES) {
    const option = make('label', 'ezr-theme-option');
    const radio = make('input', 'ezr-theme-radio');
    radio.type = 'radio';
    radio.name = 'ezr-theme';
    radio.value = theme.value;
    radio.setAttribute('aria-label', theme.label);
    radio.setAttribute('data-ezr-setting', 'theme');
    radio.addEventListener('change', () => { if (radio.checked) emit({ theme: theme.value }); });
    option.appendChild(radio);
    option.appendChild(make('span', `ezr-theme-sample ezr-theme-${theme.value}`, 'Aa'));
    option.appendChild(make('span', 'ezr-theme-name', theme.label));
    themeGrid.appendChild(option);
    syncers.push(settings => { radio.checked = settings.theme === theme.value; });
  }
  themeField.appendChild(themeGrid);
  display.appendChild(themeField);
  display.appendChild(checkRow({ key: 'capitalizeFirst', label: '单词首字母大写', description: '两种视图均可使用，不改写网页文字' }));
  display.appendChild(checkRow({ key: 'rememberPerSite', label: '按网站记住显示设置', description: '配色和排版按网站保存；翻译设置在各网站共用' }));

  const translation = section('04', '翻译与划词');
  const translationSettings = createTranslationSettings(translation, { doc });
  const readerHint = make('p', 'ezr-field-description', '进入简洁阅读后，可调整字体、段落与词语学习设置。');
  scroll.appendChild(readerHint);

  // 底部
  const footer = make('div', 'ezr-settings-foot');
  const resetBtn = make('button', 'ezr-btn ezr-settings-reset', '恢复默认');
  resetBtn.type = 'button';
  resetBtn.setAttribute('aria-label', '恢复默认设置');
  resetBtn.setAttribute('title', '恢复默认设置');
  resetBtn.addEventListener('click', (event) => {
    event.preventDefault();
    if (typeof opts.onReset === 'function') {
      try {
        opts.onReset();
      } catch {
        /* 回调异常不影响面板 */
      }
    }
  });
  footer.appendChild(resetBtn);
  footer.appendChild(make('span', 'ezr-settings-live', '更改即时生效'));
  panel.appendChild(footer);

  container.appendChild(backdrop);
  container.appendChild(panel);

  /**
   * 用最新设置同步所有控件（不会触发 onChange）。
   * @param {Object} settings 设置。
   * @returns {void}
   */
  const update = (settings) => {
    if (destroyed || !settings) return;
    panel.style.colorScheme = settings.theme === 'auto' ? 'light dark' : settings.theme === 'dark' ? 'dark' : 'light';
    for (const sync of syncers) {
      try {
        sync(settings);
      } catch {
        /* 单个控件失败不影响其它控件 */
      }
    }
  };

  const setPreviewing = (value) => {
    previewing = !!value;
    description.textContent = previewing ? '调整翻译偏好与工具栏外观。' : '排版、翻译与学习偏好，即时生效。';
    for (const group of [typography, content, zoomField]) {
      group.hidden = previewing;
      for (const control of group.querySelectorAll('input,select,button')) control.disabled = previewing;
    }
    translationSettings.setPreviewing(previewing);
    readerHint.hidden = !previewing;
    const sections = previewing ? [translation, display, typography, content] : [typography, content, display, translation];
    sections.forEach((group, index) => { scroll.appendChild(group); group.querySelector('.ezr-section-number').textContent = String(index + 1).padStart(2, '0'); });
    scroll.appendChild(readerHint);
    resetBtn.textContent = previewing ? '恢复界面默认' : '恢复阅读默认';
    resetBtn.title = previewing ? '恢复配色、大写和站点显示偏好，不更改翻译设置' : '恢复阅读设置，不更改翻译设置';
  };

  /** 打开面板。 */
  const openPanel = () => {
    if (destroyed || open) return;
    open = true;
    previousFocus = panel.getRootNode().activeElement || doc.activeElement;
    backdrop.hidden = false;
    panel.hidden = false;
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    if ('inert' in panel) panel.inert = false;
    scroll.scrollTop = 0;
    closeBtn.focus({ preventScroll: true });
  };

  /** 关闭面板。 */
  const close = () => {
    if (destroyed) return;
    open = false;
    panel.classList.remove('is-open');
    panel.hidden = true;
    backdrop.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
    if ('inert' in panel) panel.inert = true;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  };

  /** 切换面板。 */
  const toggle = () => {
    if (open) close();
    else openPanel();
  };

  panel.addEventListener('keydown', (event) => {
    if (!open || event.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled)')].filter(control => control.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    const focused = panel.getRootNode().activeElement;
    if (event.shiftKey && focused === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault();
      first.focus();
    }
  });

  close();
  if (opts.settings) update(opts.settings);
  setPreviewing(previewing);

  /** 释放定时器并移除面板；幂等。 */
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    pending = null;
    syncers.length = 0;
    translationSettings.destroy();
    try {
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      backdrop.remove();
    } catch {
      /* 忽略 */
    }
  };

  return {
    open: openPanel,
    close,
    toggle,
    update,
    setPreviewing,
    get isOpen() {
      return open;
    },
    element: panel,
    destroy,
  };
}
