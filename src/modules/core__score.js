/**
 * Candidate scoring for the content extractor: a higher score means "this
 * subtree looks like the article body".
 */

import { NEGATIVE_HINT_RE, POSITIVE_HINT_RE } from './constants.js';

/** Bonus for a positive hint hit. @type {number} */
const POSITIVE_BONUS = 3;

/** Penalty for a negative hint hit. @type {number} */
const NEGATIVE_PENALTY = 6;

/** Text length is capped before it is converted into points. @type {number} */
const TEXT_LENGTH_CAP = 5000;

/** Points per 100 characters of text. @type {number} */
const TEXT_LENGTH_DIVISOR = 100;

/** Link-density weight. @type {number} */
const LINK_RATIO_WEIGHT = 8;

/** Link density above which a candidate must score negative. @type {number} */
const LINK_RATIO_LIMIT = 0.5;

/** Score forced onto over-linked candidates (strictly negative). @type {number} */
const NEGATIVE_FLOOR = -1;

/**
 * @typedef {Object} CandidateStats
 * @property {number} [paraCount]      number of paragraph-ish descendants
 * @property {number} [textLength]     total text length
 * @property {number} [linkTextLength] text length inside links
 * @property {string} [className]      class attribute / class list text
 * @property {string} [id]             id attribute
 * @property {string} [tagName]        tag name
 */

/**
 * @typedef {Object} Candidate
 * @property {CandidateStats} [stats]
 * @property {number} [depth]
 * @property {string} [path]
 */

/**
 * Read a finite number, or 0.
 * @param {unknown} value candidate
 * @returns {number} a finite number
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read a string, or ''.
 * @param {unknown} value candidate
 * @returns {string} a string
 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Score one candidate subtree.
 *
 * `score = paraCount + min(textLength, 5000) / 100 - linkRatio * 8
 *          + (positive hint ? 3 : 0) - (negative hint ? 6 : 0)`
 *
 * A candidate whose link density exceeds 0.5 always ends up negative, whatever
 * the raw formula says.
 *
 * @param {CandidateStats} [stats] candidate statistics
 * @returns {number} score; higher is better, over-linked candidates are negative
 */
export function scoreCandidate(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const paraCount = num(s.paraCount);
  const textLength = Math.max(0, num(s.textLength));
  const linkTextLength = Math.max(0, num(s.linkTextLength));
  const linkRatio = textLength > 0 ? Math.min(1, linkTextLength / textLength) : (linkTextLength > 0 ? 1 : 0);

  const hints = [str(s.className), str(s.id), str(s.tagName)].filter((part) => part !== '').join(' ');
  const positive = hints !== '' && POSITIVE_HINT_RE.test(hints);
  const negative = hints !== '' && NEGATIVE_HINT_RE.test(hints);

  let score = paraCount
    + Math.min(textLength, TEXT_LENGTH_CAP) / TEXT_LENGTH_DIVISOR
    - linkRatio * LINK_RATIO_WEIGHT
    + (positive ? POSITIVE_BONUS : 0)
    - (negative ? NEGATIVE_PENALTY : 0);

  if (linkRatio > LINK_RATIO_LIMIT) score = Math.min(score, NEGATIVE_FLOOR);
  return score;
}

/**
 * Pick the best candidate: highest score wins, ties go to the smallest depth,
 * and a full tie keeps the first candidate in input order.
 *
 * @param {Candidate[]} candidates candidate list (`{stats, depth, path}`)
 * @returns {Candidate|null} the winning candidate object (not a copy), or null
 */
export function pickBest(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  /** @type {Candidate|null} */
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestDepth = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const entry = candidate && typeof candidate === 'object' ? candidate : {};
    const score = scoreCandidate(entry.stats);
    const depth = Number.isFinite(entry.depth) ? /** @type {number} */ (entry.depth) : Number.POSITIVE_INFINITY;
    if (best === null || score > bestScore || (score === bestScore && depth < bestDepth)) {
      best = entry;
      bestScore = score;
      bestDepth = depth;
    }
  }
  return best;
}
