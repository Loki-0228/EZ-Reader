/**
 * Settings normalization, merging, per-origin resolution and storage keys.
 * Everything here is pure: inputs are validated, never trusted and never
 * modified, and a complete settings object always comes back out.
 */

import {
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  SETTING_LIMITS,
  clamp,
} from './constants.js';

/** @type {ReadonlyArray<string>} */
const BOOLEAN_FIELDS = Object.freeze([
  'splitLines',
  'capitalizeFirst',
  'showOutline',
  'rememberPerSite',
  'restorePosition',
]);

/** @type {ReadonlyArray<string>} */
const STRING_FIELDS = Object.freeze(['capitalizeLocales']);

/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
const ENUM_FIELDS = Object.freeze({
  headingMode: Object.freeze(['conservative', 'standard', 'aggressive']),
  zoomMode: Object.freeze(['fit-width', 'fit-page', 'manual']),
  theme: Object.freeze(['light', 'sepia', 'dark', 'auto']),
  toolbarDock: Object.freeze(['top', 'bottom']),
});

/** CJK ideographs, kana, hangul and CJK punctuation. @type {RegExp} */
const CJK_RE = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3130-\u318F\u31C0-\u31EF\u3200-\u32FF\u3300-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/gu;

/** CJK share threshold: `cjk / total > 0.3`, compared as `cjk * 10 > total * 3`. @type {number} */
const CJK_RATIO_NUMERATOR = 3;

/** @type {number} */
const CJK_RATIO_DENOMINATOR = 10;

/**
 * Is the value a non-null plain-ish object?
 * @param {unknown} value candidate
 * @returns {boolean} true when the value can be read as a record
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize one settings field.
 * @param {string} key field name
 * @param {unknown} value raw value from storage
 * @param {unknown} fallback default value for the field
 * @returns {unknown} the validated value, or the default
 */
function normalizeField(key, value, fallback) {
  if (key === 'fontId') {
    return typeof value === 'string' && FONT_FAMILIES.some((family) => family.id === value) ? value : fallback;
  }
  if (key === 'gapOverridePx') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  if (BOOLEAN_FIELDS.includes(key)) {
    return typeof value === 'boolean' ? value : fallback;
  }
  if (STRING_FIELDS.includes(key)) {
    return typeof value === 'string' ? value : fallback;
  }
  const enumValues = ENUM_FIELDS[key];
  if (enumValues !== undefined) {
    return typeof value === 'string' && enumValues.includes(value) ? value : fallback;
  }
  const limits = SETTING_LIMITS[key];
  if (limits !== undefined) {
    return typeof value === 'number' && Number.isFinite(value) ? clamp(value, limits.min, limits.max) : fallback;
  }
  return fallback;
}

/**
 * Validate and complete a settings object.
 *
 * Every known field is checked individually and clamped into its legal range;
 * unknown fields are dropped and an unusable value (wrong type, `NaN`, …) falls
 * back to the default for that field. A complete object is always returned —
 * never `null`, never a partial one.
 *
 * @param {unknown} raw settings candidate (usually from storage)
 * @returns {Record<string, unknown>} complete settings object
 */
export function normalizeSettings(raw) {
  const source = isRecord(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    out[key] = normalizeField(key, source[key], DEFAULT_SETTINGS[key]);
  }
  return out;
}

/**
 * Shallow (one level) merge of two settings-ish objects. Keys whose override
 * value is `undefined` keep the base value, so partial overrides never wipe
 * defaults.
 *
 * @param {unknown} base base object
 * @param {unknown} override values that win
 * @returns {Record<string, unknown>} new merged object
 */
export function mergeSettings(base, override) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (isRecord(base)) {
    for (const key of Object.keys(base)) out[key] = /** @type {Record<string, unknown>} */ (base)[key];
  }
  if (isRecord(override)) {
    const patch = /** @type {Record<string, unknown>} */ (override);
    for (const key of Object.keys(patch)) {
      if (patch[key] !== undefined) out[key] = patch[key];
    }
  }
  return out;
}

/**
 * Resolve the effective settings for one origin.
 *
 * When `defaults.rememberPerSite` is true and `byOrigin[origin]` exists, the
 * per-origin partial settings override the defaults; otherwise the defaults are
 * used as-is. The result is normalized, so a complete settings object is
 * returned either way.
 *
 * @param {unknown} defaults complete (or partial) default settings
 * @param {unknown} byOrigin map of `origin -> Partial<Settings>`
 * @param {string} origin origin key of the current page
 * @returns {Record<string, unknown>} effective settings
 */
export function resolveSettings(defaults, byOrigin, origin) {
  const base = isRecord(defaults) ? /** @type {Record<string, unknown>} */ (defaults) : DEFAULT_SETTINGS;
  const remember = base.rememberPerSite === true;
  const originKey = typeof origin === 'string' ? origin : '';

  /** @type {unknown} */
  let patch = null;
  if (remember && originKey !== '' && isRecord(byOrigin) && Object.hasOwn(byOrigin, originKey)) {
    patch = /** @type {Record<string, unknown>} */ (byOrigin)[originKey];
  }
  return normalizeSettings(mergeSettings(base, patch));
}

/**
 * Is the text CJK dominant (more than 30% CJK / kana / hangul code points)?
 * The comparison uses integer arithmetic (`cjk * 10 > total * 3`) so the exact
 * 30% boundary is not affected by floating point rounding.
 * @param {unknown} text text to inspect
 * @returns {boolean} true when CJK characters make up more than 30% of the text
 */
export function isCjkDominant(text) {
  const s = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
  if (s === '') return false;
  const total = [...s].length;
  if (total === 0) return false;
  const matches = s.match(CJK_RE);
  if (matches === null) return false;
  let cjk = 0;
  for (const match of matches) cjk += [...match].length;
  return cjk * CJK_RATIO_DENOMINATOR > total * CJK_RATIO_NUMERATOR;
}

/**
 * CSS font stack for a font id. Unknown ids fall back to the first family.
 * @param {unknown} id font id from settings
 * @returns {string} CSS font-family stack
 */
export function fontStackById(id) {
  const found = FONT_FAMILIES.find((family) => family.id === id);
  return found === undefined ? FONT_FAMILIES[0].stack : found.stack;
}

/**
 * Storage key for a settings or position record.
 *
 * Per-origin records are namespaced by origin; the shared buckets keep the keys
 * documented in CONTRACTS.md §14 (`ezr:settings:default`, `ezr:pos`).
 *
 * @param {unknown} origin page origin (`''`, `null` or `'default'` mean "shared")
 * @param {'settings'|'pos'} kind record kind
 * @returns {string} chrome.storage.local key
 */
export function storageKeyFor(origin, kind) {
  const namespace = kind === 'pos' ? 'pos' : 'settings';
  const key = typeof origin === 'string' ? origin.trim() : '';
  if (key === '' || key === 'default') {
    return namespace === 'settings' ? 'ezr:settings:default' : 'ezr:pos';
  }
  return `ezr:${namespace}:${key}`;
}
