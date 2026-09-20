/**
 * Block classification: decide whether an IR block is a heading (and which
 * level a native heading has) or plain content, and flag page chrome.
 *
 * Pure and DOM-free: it only ever reads `block.text`, `block.fontSize`,
 * `block.fontWeight`, `block.bold`, `block.allCaps`, `block.centered`,
 * `block.lines`, `block.nativeLevel` and the class/id-ish hints.
 */

import {
  DEFAULT_SETTINGS,
  MAX_HEADING_LEVEL,
  MIN_HEADING_LEVEL,
  NEGATIVE_HINT_RE,
  clamp,
} from './constants.js';

/** Font weight at (or above) which text counts as bold. @type {number} */
const BOLD_MIN_WEIGHT = 600;

/** "standard" mode: size ratio that needs a supporting signal. @type {number} */
const SIGNAL_SIZE_RATIO = 1.15;

/** "standard" mode: size ratio that is a heading on its own. @type {number} */
const STRONG_SIZE_RATIO = 1.6;

/** "standard" mode: max text length for the size+signal rule. @type {number} */
const SIGNAL_MAX_LENGTH = 120;

/** "standard"/"aggressive" modes: max length of an ALL-CAPS heading. @type {number} */
const ALL_CAPS_MAX_LENGTH = 80;

/** "aggressive" mode: max length of a standalone bold line. @type {number} */
const BOLD_LINE_MAX_LENGTH = 80;

/** Chrome heuristic: max length of a chrome-ish short text. @type {number} */
const CHROME_TEXT_MAX_LENGTH = 60;

/** Chrome heuristic: max word count of a chrome-ish short text. @type {number} */
const CHROME_TEXT_MAX_WORDS = 8;

/** Structural block types that are never promoted to headings. @type {ReadonlySet<string>} */
const STRUCTURAL_TYPES = new Set(['li', 'quote', 'code', 'table', 'figure', 'hr']);

/** Tags that are chrome by nature. @type {ReadonlySet<string>} */
const CHROME_TAGS = new Set(['nav', 'aside', 'footer', 'menu', 'menubar']);

/** ARIA roles that are chrome by definition. @type {ReadonlySet<string>} */
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar']);

/** Default body font size used when the context omits one. @type {number} */
const FALLBACK_BODY_FONT_SIZE = DEFAULT_SETTINGS.bodyFontSize;

/** Default body line height used when the context omits one. @type {number} */
const FALLBACK_BODY_LINE_HEIGHT = DEFAULT_SETTINGS.bodyFontSize * DEFAULT_SETTINGS.lineHeight;

/**
 * @typedef {Object} ClassifyContext
 * @property {number} [bodyFontSize]     body baseline font size in px
 * @property {number} [bodyLineHeightPx] body baseline line height in px
 * @property {'conservative'|'standard'|'aggressive'} [mode] heading detection mode
 */

/**
 * @typedef {Object} ClassifyResult
 * @property {'heading'|'para'|'li'|'quote'|'code'|'table'|'figure'|'hr'} type
 * @property {number} [level]    1..6, only for headings
 * @property {boolean} [bold]    true when boldness drove the decision
 * @property {boolean} [allCaps] true when ALL-CAPS drove the decision
 * @property {boolean} [centered] true when centering drove the decision
 */

/**
 * Read a string field defensively.
 * @param {unknown} value candidate
 * @returns {string} the value when it is a string, otherwise ''
 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Normalize the classify context, filling in defaults.
 * @param {ClassifyContext} [context] raw context
 * @returns {{bodyFontSize: number, bodyLineHeightPx: number, mode: 'conservative'|'standard'|'aggressive'}}
 *   complete context
 */
function normalizeContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const size = Number.isFinite(c.bodyFontSize) && c.bodyFontSize > 0 ? c.bodyFontSize : FALLBACK_BODY_FONT_SIZE;
  const lineHeight = Number.isFinite(c.bodyLineHeightPx) && c.bodyLineHeightPx > 0 ? c.bodyLineHeightPx : FALLBACK_BODY_LINE_HEIGHT;
  const mode = c.mode === 'conservative' || c.mode === 'aggressive' ? c.mode : 'standard';
  return { bodyFontSize: size, bodyLineHeightPx: lineHeight, mode };
}

/**
 * Effective boldness of a block.
 * @param {Record<string, unknown>} block IR block
 * @returns {boolean} true when the block is bold
 */
function isBold(block) {
  if (block.bold === true) return true;
  const weight = block.fontWeight;
  return typeof weight === 'number' && Number.isFinite(weight) && weight >= BOLD_MIN_WEIGHT;
}

/**
 * Native heading level of a block (from an `h1`..`h6` tag or `role=heading`).
 * @param {Record<string, unknown>} block IR block
 * @returns {number|null} clamped 1..6, or null when the block is not native
 */
function nativeLevelOf(block) {
  const raw = block.nativeLevel;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < MIN_HEADING_LEVEL) return null;
  return clamp(Math.round(raw), MIN_HEADING_LEVEL, MAX_HEADING_LEVEL);
}

/**
 * Boolean signals that a heuristic heading detection may report back.
 * @param {Record<string, unknown>} block IR block
 * @returns {{bold?: boolean, allCaps?: boolean, centered?: boolean}} partial patch
 */
function signalPatch(block) {
  /** @type {{bold?: boolean, allCaps?: boolean, centered?: boolean}} */
  const patch = {};
  if (isBold(block)) patch.bold = true;
  if (block.allCaps === true) patch.allCaps = true;
  if (block.centered === true) patch.centered = true;
  return patch;
}

/**
 * Classify one IR block.
 *
 * Modes (thresholds from CONTRACTS.md §6):
 *  - `conservative`: only native heading tags / `role=heading` become headings.
 *  - `standard`: native tags; or `fontSize >= 1.15 * bodyFontSize` together with
 *    bold/centered/allCaps and `text.length <= 120`; or `fontSize >= 1.6 * body`;
 *    or `allCaps && text.length <= 80`.
 *  - `aggressive`: everything from `standard`, plus a standalone bold short line
 *    (`bold && text.length <= 80`) and a bold `<br>`-separated short line group.
 *
 * Only partial fields are returned and the input block is never modified.
 * Heuristic detections carry the signal(s) that triggered them; non-headings
 * return `{ type }` only.
 *
 * @param {unknown} block IR block to classify
 * @param {ClassifyContext} [context] body baseline + mode
 * @returns {ClassifyResult} partial fields to merge into the block
 */
export function classifyBlock(block, context) {
  const b = block && typeof block === 'object' ? /** @type {Record<string, unknown>} */ (block) : {};
  const ctx = normalizeContext(context);
  const text = b.text === null || b.text === undefined ? '' : String(b.text);
  const trimmed = text.trim();

  const native = nativeLevelOf(b);
  if (native !== null) return { type: 'heading', level: native };

  // Already decided to be a heading by an earlier stage: keep it (idempotent).
  if (b.type === 'heading') {
    const level = Number.isFinite(b.level) ? clamp(Math.round(/** @type {number} */ (b.level)), MIN_HEADING_LEVEL, MAX_HEADING_LEVEL) : 2;
    return { type: 'heading', level };
  }

  const type = typeof b.type === 'string' && b.type !== '' ? b.type : 'para';
  const structural = STRUCTURAL_TYPES.has(type);

  const detected = structural ? null : detectHeuristicHeading(b, text, trimmed, ctx);
  if (detected !== null) {
    return { type: 'heading', level: 2, ...signalPatch(b) };
  }
  return { type: structural ? /** @type {ClassifyResult['type']} */ (type) : 'para' };
}

/**
 * Apply the mode's heuristic heading rules.
 * @param {Record<string, unknown>} block IR block
 * @param {string} text raw text (length checks use it verbatim)
 * @param {string} trimmed trimmed text (empty blocks are never headings)
 * @param {{bodyFontSize: number, bodyLineHeightPx: number, mode: 'conservative'|'standard'|'aggressive'}} ctx context
 * @returns {string|null} rule id when the block is a heading, otherwise null
 */
function detectHeuristicHeading(block, text, trimmed, ctx) {
  if (ctx.mode === 'conservative') return null;
  if (trimmed === '') return null;

  const size = typeof block.fontSize === 'number' && Number.isFinite(block.fontSize) ? block.fontSize : Number.NaN;
  const ratio = Number.isFinite(size) ? size / ctx.bodyFontSize : 0;
  const bold = isBold(block);
  const allCaps = block.allCaps === true;
  const centered = block.centered === true;

  if (ratio >= SIGNAL_SIZE_RATIO && (bold || centered || allCaps) && text.length <= SIGNAL_MAX_LENGTH) return 'size-signal';
  if (ratio >= STRONG_SIZE_RATIO) return 'size-strong';
  if (allCaps && text.length <= ALL_CAPS_MAX_LENGTH) return 'all-caps';

  if (ctx.mode === 'aggressive') {
    if (bold && text.length <= BOLD_LINE_MAX_LENGTH) return 'bold-line';
    const lines = Array.isArray(block.lines) ? block.lines : null;
    if (bold && lines !== null && lines.length > 1 && lines.every(
      (line) => typeof line === 'string' && line.trim() !== '' && line.trim().length <= BOLD_LINE_MAX_LENGTH,
    )) return 'bold-br-lines';
  }
  return null;
}

/**
 * Heuristic page-chrome detection (nav / footer / share / related / ads…).
 *
 * Signals, in order: structural tags and ARIA roles, negative class/id/path
 * hints, and a short few-word label matching the negative hint words. Long
 * article text that merely *mentions* "share" or "menu" is never chrome.
 *
 * @param {unknown} block IR block
 * @param {ClassifyContext} [context] unused today, kept for contract symmetry
 * @returns {boolean} true when the block looks like page chrome
 */
export function isChromeBlock(block, context) {
  void context;
  const b = block && typeof block === 'object' ? /** @type {Record<string, unknown>} */ (block) : {};

  const tag = str(b.kind) || str(b.tagName);
  if (tag !== '' && CHROME_TAGS.has(tag.toLowerCase())) return true;

  const role = str(b.role).toLowerCase();
  if (role !== '' && CHROME_ROLES.has(role)) return true;

  const haystack = [str(b.className), str(b.id), str(b.name), str(b.role), str(b.tagName), str(b.srcPath)]
    .filter((part) => part !== '')
    .join(' ');
  if (haystack !== '' && NEGATIVE_HINT_RE.test(haystack)) return true;

  const text = b.text === null || b.text === undefined ? '' : String(b.text).trim();
  if (text !== '' && text.length <= CHROME_TEXT_MAX_LENGTH && countWords(text) <= CHROME_TEXT_MAX_WORDS) {
    if (NEGATIVE_HINT_RE.test(text)) return true;
  }
  return false;
}

/**
 * Count whitespace separated words.
 * @param {string} text text to inspect
 * @returns {number} word count
 */
function countWords(text) {
  const matches = text.match(/\S+/g);
  return matches === null ? 0 : matches.length;
}
