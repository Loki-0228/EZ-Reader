/**
 * Paragraph gap — the single source of truth for vertical rhythm.
 *
 * Invariants (hard product requirements):
 *   1. The returned gap is ALWAYS strictly greater than `1.5 * lineHeightPx`
 *      ("段间距必须大于 1.5 倍行距").
 *   2. The returned gap is monotonically non-decreasing as `lineHeightPx` grows.
 *
 * Both invariants hold for every input, including degenerate ones.
 */

import { DEFAULT_SETTINGS } from './constants.js';

/** Minimum gap / line-height ratio required by the product. @type {number} */
const MIN_GAP_RATIO = 1.5;

/** Relative nudge so the result is strictly greater than `1.5 * lineHeightPx`. @type {number} */
const RELATIVE_EPSILON = 1e-9;

/** Absolute nudge that keeps the gap strictly positive even at lineHeightPx = 0. @type {number} */
const ABSOLUTE_EPSILON = 1e-9;

/** Extra breathing room applied on top of the `gapExtraPx` floor. @type {number} */
const LINE_HEIGHT_EXTRA_RATIO = 0.05;

/**
 * Line height used when the caller passes nothing usable (16px × 1.6 = 25.6px).
 * @type {number}
 */
const FALLBACK_LINE_HEIGHT_PX = DEFAULT_SETTINGS.bodyFontSize * DEFAULT_SETTINGS.lineHeight;

/**
 * Return a finite number, or `fallback` when the value is not usable.
 * @param {unknown} value candidate
 * @param {number} fallback value used for non-finite input
 * @returns {number} a finite number
 */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Compute the paragraph gap in px.
 *
 * `gapOverridePx` (when finite) is used as a manual gap, still floored above
 * `1.5 * lineHeightPx`. Otherwise:
 *   base  = gapFactor * lineHeightPx
 *   extra = max(gapExtraPx, lineHeightPx * 0.05)
 *   gap   = base + extra
 *
 * Degenerate input is clamped, never propagated: a non-finite `lineHeightPx`
 * falls back to 25.6px, a negative one is treated as 0, and negative
 * `gapFactor` / `gapExtraPx` are raised to 0 (which keeps monotonicity).
 *
 * @param {{lineHeightPx?: number, gapFactor?: number, gapExtraPx?: number, gapOverridePx?: number|null}} [options]
 *   gap inputs; missing or non-finite fields fall back to the defaults
 * @returns {number} gap in px, always finite and strictly `> 1.5 * lineHeightPx`
 *   (including at `lineHeightPx === 0`, where the result is a tiny positive
 *   number rather than 0)
 */
export function paragraphGapPx(options) {
  const o = options && typeof options === 'object' ? options : {};
  const rawLineHeight = finiteOr(o.lineHeightPx, FALLBACK_LINE_HEIGHT_PX);
  const lineHeightPx = rawLineHeight > 0 ? rawLineHeight : 0;
  const gapFactor = Math.max(0, finiteOr(o.gapFactor, DEFAULT_SETTINGS.gapFactor));
  const gapExtraPx = Math.max(0, finiteOr(o.gapExtraPx, DEFAULT_SETTINGS.gapExtraPx));

  const minGap = (MIN_GAP_RATIO * lineHeightPx) + Math.max(ABSOLUTE_EPSILON, MIN_GAP_RATIO * lineHeightPx * RELATIVE_EPSILON);

  const override = o.gapOverridePx;
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(override, minGap);
  }

  const base = gapFactor * lineHeightPx;
  const extra = Math.max(gapExtraPx, lineHeightPx * LINE_HEIGHT_EXTRA_RATIO);
  return Math.max(base + extra, minGap);
}
