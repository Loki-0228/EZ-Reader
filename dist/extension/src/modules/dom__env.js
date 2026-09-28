/**
 * @file 浏览器环境薄封装：文档访问、计算样式、可见性、长度解析与几何读取。
 * 本模块 **不导入任何其它模块**（零依赖），是所有 DOM 相关代码的最底层。
 * 所有函数都保证「不抛异常」，失败时返回保守值。
 */

/**
 * 取得当前文档。
 * @returns {Document} 全局 document。
 * @throws {Error} 当运行环境没有 document 时。
 */
export function getDoc() {
  const doc = globalThis.document;
  if (!doc) throw new Error('ezr/env: no document');
  return doc;
}

/**
 * 安全读取元素的计算样式；不可用时返回空对象。
 * @param {Element|null|undefined} el 目标元素。
 * @returns {CSSStyleDeclaration|Object} 计算样式对象，失败时为 `{}`。
 */
export function styleOf(el) {
  if (!el) return {};
  try {
    const doc = el.ownerDocument ?? globalThis.document ?? null;
    const view = doc && doc.defaultView ? doc.defaultView : globalThis;
    if (!view || typeof view.getComputedStyle !== 'function') return {};
    return view.getComputedStyle(el) ?? {};
  } catch {
    return {};
  }
}

/**
 * 判断元素是否可见。优先使用 `checkVisibility()`，否则退回
 * display / visibility / 边界框尺寸三重判断。永不抛异常，失败视为不可见。
 * @param {Element|null|undefined} el 目标元素。
 * @param {CSSStyleDeclaration|Object} [cs] 已取得的计算样式（可选，避免重复 getComputedStyle）。
 * @returns {boolean} 是否可见。
 */
export function isVisible(el, cs) {
  if (!el || el.nodeType !== 1) return false;
  try {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }) === true;
    }
  } catch {
    /* 老版本 Chrome 或不支持该参数：走下面的兜底逻辑 */
  }
  try {
    const style = cs ?? styleOf(el);
    const display = style && style.display;
    if (display === 'none') return false;
    const visibility = style && style.visibility;
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    if (typeof el.getBoundingClientRect !== 'function') return true;
    const rect = el.getBoundingClientRect();
    return !!rect && rect.width > 0 && rect.height > 0;
  } catch {
    return false;
  }
}

/**
 * 解析长度字符串为数字（`'14px'` → `14`）。
 * @param {string|number|null|undefined} value 长度值。
 * @param {number} [fallback=0] 非法值时返回的兜底值。
 * @returns {number} 有限数字，或 fallback。
 */
export function px(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value !== 'string') return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 解析长度字符串；`''`/`'normal'`/`'auto'` 与非法值都返回 null。
 * @param {string|number|null|undefined} value 长度值。
 * @returns {number|null} 像素值或 null。
 */
export function pxOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '' || s === 'normal' || s === 'auto') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 由计算样式求行高像素值。`normal`/`auto`/空 → 字号 × 1.2；
 * 无单位的小数值（部分浏览器返回 `'1.6'`）按倍率处理。
 * @param {CSSStyleDeclaration|Object|null|undefined} cs 计算样式。
 * @param {number} fontSizePx 字号（px）。
 * @returns {number} 行高（px）。
 */
export function lineHeightPx(cs, fontSizePx) {
  const size = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 16;
  const fallback = size * 1.2;
  const raw = cs ? cs.lineHeight : null;
  if (raw === null || raw === undefined) return fallback;
  const s = String(raw).trim();
  if (s === '' || s === 'normal' || s === 'auto') return fallback;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return fallback;
  // 无单位写法（'1.6'）在个别实现里会原样返回：小于 4 视为倍率。
  if (n > 0 && n < 4 && !/px|pt|em|rem|%|pc|in|cm|mm|q|ex|ch|vw|vh|vmin|vmax/i.test(s)) {
    return size * n;
  }
  return n > 0 ? n : fallback;
}

/**
 * 读取元素相对视口的矩形。
 * @param {Element|null|undefined} el 目标元素。
 * @returns {{x:number,y:number,width:number,height:number}|null} 矩形，失败为 null。
 */
export function rectOf(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    const r = el.getBoundingClientRect();
    if (!r) return null;
    const num = (a, b) => {
      const v = typeof a === 'number' ? a : b;
      return Number.isFinite(v) ? v : 0;
    };
    return {
      x: num(r.x, num(r.left, 0)),
      y: num(r.y, num(r.top, 0)),
      width: num(r.width, 0),
      height: num(r.height, 0),
    };
  } catch {
    return null;
  }
}
