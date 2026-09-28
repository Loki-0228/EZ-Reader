/**
 * @file 缩放计算与自动重算。
 * 内容宽度始终在「缩放为 1」的窗口内测量，避免 zoom 影响测量结果导致自激循环。
 */

import { SETTING_LIMITS, clamp } from '../core/constants.js';
import { getDoc } from '../dom/env.js';

/** 小于该差值不重复上报。 */
const MIN_DELTA = 0.005;

/**
 * 计算目标缩放倍率。
 * @param {{mode?: string, manual?: number, containerWidth?: number, contentWidth?: number,
 *   min?: number, max?: number, padding?: number}} [opts] 选项。
 * @returns {number} 缩放倍率；输入不可用时返回 1。
 */
export function computeZoom(opts = {}) {
  const min = Number.isFinite(opts.min) ? opts.min : SETTING_LIMITS.zoom.min;
  const max = Number.isFinite(opts.max) ? opts.max : SETTING_LIMITS.zoom.max;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const mode = opts.mode === 'fit-page' || opts.mode === 'manual' ? opts.mode : 'fit-width';

  if (mode === 'manual') {
    const manual = Number(opts.manual);
    return Number.isFinite(manual) ? clamp(manual, lo, hi) : 1;
  }

  const containerWidth = Number(opts.containerWidth);
  const contentWidth = Number(opts.contentWidth);
  if (!Number.isFinite(containerWidth) || !Number.isFinite(contentWidth) || contentWidth <= 0) return 1;
  const padding = Number.isFinite(opts.padding) ? opts.padding : 0;
  const available = containerWidth - padding;
  if (!Number.isFinite(available) || available <= 0) return 1;

  // Fit width scales the design column to the window, including enlargement.
  // Keep the separate fit-page mode's existing shrink-only behavior.
  const fitted = clamp(available / contentWidth, lo, hi);
  return mode === 'fit-page' ? Math.min(1, fitted) : fitted;
}

/**
 * 是否出现横向溢出。
 * @param {HTMLElement|null|undefined} el 目标元素。
 * @returns {boolean} 内容宽度超过可视宽度 1px 以上时为 true。
 */
export function hasHorizontalOverflow(el) {
  if (!el) return false;
  try {
    const scrollWidth = Number(el.scrollWidth);
    const clientWidth = Number(el.clientWidth);
    if (!Number.isFinite(scrollWidth) || !Number.isFinite(clientWidth)) return false;
    return scrollWidth > clientWidth + 1;
  } catch {
    return false;
  }
}

/**
 * 创建缩放缓动器：容器尺寸变化时重新计算并上报缩放。
 * @param {{element: HTMLElement, measure?: () => number, getSettings?: () => Object,
 *   onChange?: (zoom: number) => void, doc?: Document, padding?: number,
 *   containerWidth?: (number|(() => number))}} opts 选项。
 *   `measure()` 在 `--ezr-scale` 被临时置为 1 的窗口内调用；缺省时读取 `element.scrollWidth`。
 * @returns {{recalc: () => void, destroy: () => void}} 句柄。
 */
export function createZoomWatcher(opts = {}) {
  const element = opts.element ?? null;
  const doc = opts.doc ?? element?.ownerDocument ?? getDoc();
  const view = doc && doc.defaultView ? doc.defaultView : globalThis;
  const padding = Number.isFinite(opts.padding) ? opts.padding : 0;

  let destroyed = false;
  let rafId = 0;
  let scheduled = false;
  let reporting = false;
  let lastZoom = -1;
  /** @type {ResizeObserver|null} */
  let observer = null;
  const controller = new AbortController();

  /**
   * 取容器可视宽度（优先 parentElement，避免受自身 zoom 影响）。
   * @returns {number} 宽度（px）。
   */
  const containerWidthOf = () => {
    if (typeof opts.containerWidth === 'function') {
      const v = Number(opts.containerWidth());
      return Number.isFinite(v) ? v : 0;
    }
    if (Number.isFinite(opts.containerWidth)) return Number(opts.containerWidth);
    if (!element) return 0;
    const parent = element.parentElement;
    const candidates = [parent ? parent.clientWidth : NaN, element.clientWidth];
    for (const c of candidates) {
      const v = Number(c);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return 0;
  };

  /**
   * 在 scale=1 的窗口内测量内容宽度。
   * @returns {number} 内容宽度（px）。
   */
  const contentWidthOf = () => {
    if (!element) return 0;
    const style = element.style;
    let previous = '';
    let patched = false;
    if (style && typeof style.setProperty === 'function') {
      try {
        previous = style.getPropertyValue('--ezr-scale');
        style.setProperty('--ezr-scale', '1');
        patched = true;
      } catch {
        patched = false;
      }
    }
    let width = 0;
    try {
      if (typeof opts.measure === 'function') {
        const measured = opts.measure();
        width = typeof measured === 'number' ? measured : parseFloat(measured);
      } else {
        width = Number(element.scrollWidth);
      }
    } catch {
      width = 0;
    }
    if (patched) {
      try {
        if (previous) style.setProperty('--ezr-scale', previous);
        else style.removeProperty('--ezr-scale');
      } catch {
        /* 恢复失败时保持 1，下一帧会重算 */
      }
    }
    return Number.isFinite(width) ? width : 0;
  };

  /** 计算并上报一次缩放。 */
  const report = () => {
    if (destroyed || reporting) return;
    reporting = true;
    try {
      let settings = null;
      try {
        settings = typeof opts.getSettings === 'function' ? opts.getSettings() : null;
      } catch {
        settings = null;
      }
      const s = settings ?? {};
      const zoom = computeZoom({
        mode: s.zoomMode,
        manual: s.zoom,
        containerWidth: containerWidthOf(),
        contentWidth: contentWidthOf(),
        min: SETTING_LIMITS.zoom.min,
        max: SETTING_LIMITS.zoom.max,
        padding,
      });
      if (lastZoom >= 0 && Math.abs(zoom - lastZoom) < MIN_DELTA) return;
      lastZoom = zoom;
      if (typeof opts.onChange === 'function') {
        try {
          opts.onChange(zoom);
        } catch {
          /* 回调异常不影响后续重算 */
        }
      }
    } finally {
      reporting = false;
    }
  };

  /** 用 requestAnimationFrame 合并连续触发。 */
  const recalc = () => {
    if (destroyed || scheduled) return;
    scheduled = true;
    const raf = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame.bind(view) : null;
    if (raf) {
      rafId = raf(() => {
        scheduled = false;
        rafId = 0;
        report();
      });
    } else {
      rafId = setTimeout(() => {
        scheduled = false;
        rafId = 0;
        report();
      }, 16);
    }
  };

  const ResizeObserverCtor = view.ResizeObserver ?? globalThis.ResizeObserver ?? null;
  if (element && typeof ResizeObserverCtor === 'function') {
    try {
      observer = new ResizeObserverCtor(() => recalc());
      observer.observe(element);
      if (element.parentElement) observer.observe(element.parentElement);
    } catch {
      observer = null;
    }
  }
  if (!observer) {
    // 兜底：窗口尺寸变化
    try {
      view.addEventListener('resize', recalc, { signal: controller.signal });
    } catch {
      /* stub 环境无 addEventListener */
    }
  }

  recalc();

  /** 释放观察器与待执行帧；幂等。 */
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        /* 忽略 */
      }
      observer = null;
    }
    try {
      controller.abort();
    } catch {
      /* 已中止 */
    }
    if (rafId) {
      try {
        const cancel = typeof view.cancelAnimationFrame === 'function' ? view.cancelAnimationFrame.bind(view) : clearTimeout;
        cancel(rafId);
      } catch {
        /* 忽略 */
      }
      rafId = 0;
    }
    scheduled = false;
  };

  return { recalc, destroy };
}
