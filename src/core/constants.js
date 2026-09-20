/**
 * EZ-Reader core constants — the single source of truth for shared literals,
 * plus the two tiny pure helpers every module reuses.
 *
 * Zero dependencies, ESM named exports only, ES2022.
 */

/**
 * @typedef {Object} FontFamily
 * @property {string} id    stable identifier persisted in settings
 * @property {string} label human readable label (zh-CN)
 * @property {string} stack CSS font-family stack (local/system fonts only)
 */

/**
 * Every block type an IR block may carry.
 * @type {ReadonlyArray<'heading'|'para'|'li'|'quote'|'code'|'table'|'figure'|'hr'>}
 */
export const BLOCK_TYPES = Object.freeze(['heading', 'para', 'li', 'quote', 'code', 'table', 'figure', 'hr']);

/** Smallest legal heading level. @type {number} */
export const MIN_HEADING_LEVEL = 1;

/** Largest legal heading level. @type {number} */
export const MAX_HEADING_LEVEL = 6;

/** Hard cap on how many blocks one page may yield. @type {number} */
export const MAX_BLOCKS = 20000;

/**
 * Font families offered in the UI. Only system / locally installed stacks —
 * nothing here may trigger a network request.
 * @type {ReadonlyArray<FontFamily>}
 */
export const FONT_FAMILIES = Object.freeze([
  Object.freeze({ id: 'serif-georgia', label: 'Georgia（衬线，推荐）', stack: "Georgia, 'Iowan Old Style', 'Times New Roman', serif" }),
  Object.freeze({ id: 'serif-charter', label: 'Charter / 宋体衬线', stack: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif" }),
  Object.freeze({ id: 'serif-palatino', label: 'Palatino（宽衬线）', stack: "'Palatino Linotype', 'Book Antiqua', Palatino, 'Source Han Serif SC', 'Songti SC', serif" }),
  Object.freeze({ id: 'sans-verdana', label: 'Verdana（大字面）', stack: "Verdana, Geneva, Tahoma, 'Microsoft YaHei', sans-serif" }),
  Object.freeze({ id: 'sans-segoe', label: 'Segoe UI / 系统无衬线', stack: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Microsoft YaHei', sans-serif" }),
  Object.freeze({ id: 'mono-consolas', label: 'Consolas（等宽）', stack: "Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', 'Courier New', monospace" }),
]);

/** Default heading font sizes for h1..h6, in px. @type {ReadonlyArray<number>} */
export const HEADING_FONT_SIZES = Object.freeze([30, 25, 21, 18, 17, 16]);

/**
 * Complete default settings object. Unknown keys are never added here.
 * @type {Readonly<Record<string, unknown>>}
 */
export const DEFAULT_SETTINGS = Object.freeze({
  // 排版
  fontId: 'serif-georgia',
  bodyFontSize: 16,        // px, 14..24
  lineHeight: 1.6,         // 无单位倍率, 1.2..2.2
  gapFactor: 1.6,          // 段间距 = gapFactor × 行高
  gapExtraPx: 2,           // 额外像素，保证严格大于 1.5L
  gapOverridePx: null,     // null = 用公式；数字 = 手动固定段间距
  measure: 44,             // rem 列宽, 24..90
  // 内容
  headingMode: 'standard', // 'conservative' | 'standard' | 'aggressive'
  splitLines: true,
  // 大小写
  capitalizeFirst: false,  // 每个单词首字母大写
  capitalizeLocales: '',   // 保留字段，暂不使用
  // 缩放
  zoomMode: 'fit-width',   // 'fit-width' | 'fit-page' | 'manual'
  zoom: 1,                 // manual 时的倍率, 0.6..2.5
  // 外观
  theme: 'light',          // 'light' | 'sepia' | 'dark' | 'auto'
  showOutline: false,
  // 行为
  rememberPerSite: true,
  restorePosition: true,
});

/**
 * Inclusive numeric ranges used by `normalizeSettings`.
 * @type {Readonly<Record<string, Readonly<{min: number, max: number}>>>}
 */
export const SETTING_LIMITS = Object.freeze({
  bodyFontSize: Object.freeze({ min: 14, max: 24 }),
  lineHeight: Object.freeze({ min: 1.2, max: 2.2 }),
  gapFactor: Object.freeze({ min: 1.15, max: 3 }),
  gapExtraPx: Object.freeze({ min: 0, max: 24 }),
  measure: Object.freeze({ min: 24, max: 90 }),
  zoom: Object.freeze({ min: 0.6, max: 2.5 }),
});

/** Noise hints (navigation, footer, sharing, ads…) for candidate scoring. @type {RegExp} */
export const NEGATIVE_HINT_RE = /(^|[^a-z])(nav|menu|sidebar|side-bar|comment|footer|share|social|related|promo|advert|ads?|cookie|breadcrumb|masthead|banner|toolbar|skip)([^a-z]|$)/i;

/** Content hints (article body, prose…) for candidate scoring. @type {RegExp} */
export const POSITIVE_HINT_RE = /(^|[^a-z])(article|main|post|content|entry|story|body|markdown|prose)([^a-z]|$)/i;

/**
 * Escape the five HTML-significant characters. Never returns `null`.
 * @param {unknown} s value to escape (non-strings are stringified)
 * @returns {string} escaped text, safe inside HTML text and quoted attributes
 */
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  const str = typeof s === 'string' ? s : String(s);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Clamp a number into `[min, max]`. Non-finite input yields `min`, which is the
 * conservative choice everywhere this helper is used (sizes, factors, zoom).
 * Malformed bounds (`min > max`) also yield `min`.
 * @param {number} n value to clamp
 * @param {number} min inclusive lower bound
 * @param {number} max inclusive upper bound
 * @returns {number} the clamped value
 */
export function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  const lo = Number.isFinite(min) ? min : n;
  const hi = Number.isFinite(max) ? max : n;
  if (lo > hi) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}
