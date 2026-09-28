/**
 * Heading level assignment: cluster heading font sizes, then map cluster order
 * to levels 1..6. Pure: the input array and its blocks are never modified.
 */

import { MAX_HEADING_LEVEL, MIN_HEADING_LEVEL, clamp } from './constants.js';

/** Default font-size tolerance (px) for putting two headings in one cluster. @type {number} */
const DEFAULT_TOLERANCE = 0.5;

/**
 * @typedef {Object} FontCluster
 * @property {number} fontSize representative (largest) font size of the cluster
 * @property {number} count    how many sizes fell into the cluster
 */

/**
 * @typedef {Object} SizeGroup
 * @property {number} fontSize representative (largest) size of the group
 * @property {number[]} values raw sizes in the group
 * @property {number[]} indices indexes into the *input* array, descending by size
 */

/**
 * Group sizes into clusters. Sizes are sorted by descending value and an entry
 * joins the current cluster when it is within `tolerance` of that cluster's
 * largest size. Because the walk is descending, membership is unambiguous.
 * @param {unknown} sizes candidate font sizes
 * @param {number} tolerance absolute tolerance in px
 * @returns {SizeGroup[]} groups ordered by descending representative size
 */
function groupSizes(sizes, tolerance) {
  const tol = Number.isFinite(tolerance) ? Math.max(0, tolerance) : DEFAULT_TOLERANCE;
  /** @type {{value: number, index: number}[]} */
  const entries = [];
  if (Array.isArray(sizes)) {
    for (let i = 0; i < sizes.length; i++) {
      const v = sizes[i];
      if (typeof v === 'number' && Number.isFinite(v)) entries.push({ value: v, index: i });
    }
  }
  entries.sort((a, b) => (b.value - a.value) || (a.index - b.index));

  /** @type {SizeGroup[]} */
  const groups = [];
  for (const entry of entries) {
    const last = groups.length > 0 ? groups[groups.length - 1] : null;
    if (last && Math.abs(last.fontSize - entry.value) <= tol) {
      last.values.push(entry.value);
      last.indices.push(entry.index);
    } else {
      groups.push({ fontSize: entry.value, values: [entry.value], indices: [entry.index] });
    }
  }
  return groups;
}

/**
 * Cluster font sizes with an absolute tolerance (default 0.5px).
 * Non-numeric / non-finite entries are ignored.
 * @param {unknown} sizes font sizes in px
 * @param {number} [tolerance=0.5] absolute tolerance in px
 * @returns {FontCluster[]} clusters ordered by descending font size
 */
export function clusterFontSizes(sizes, tolerance = DEFAULT_TOLERANCE) {
  return groupSizes(sizes, tolerance).map((group) => ({
    fontSize: group.fontSize,
    count: group.values.length,
  }));
}

/**
 * Native level hint of a block, or `Infinity` when it has none (so it sorts
 * last inside its cluster).
 * @param {unknown} block IR block
 * @returns {number} 1..6 or `Infinity`
 */
function nativeLevelOf(block) {
  if (!block || typeof block !== 'object') return Number.POSITIVE_INFINITY;
  const raw = /** @type {{nativeLevel?: unknown}} */ (block).nativeLevel;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY;
}

/**
 * Assign `level` (1..6) to every heading block of `blocks`.
 *
 * Rules: heading font sizes are clustered (0.5px tolerance) and ordered by
 * descending size; the cluster index + 1 is the level, clamped to 1..6.
 * `nativeLevel` is only used as a tie-break inside a cluster. When every
 * heading falls into a single cluster all of them become level 2.
 *
 * The input array and its blocks are never mutated: a new array with new block
 * objects is returned and non-heading blocks are copied through untouched.
 *
 * @param {unknown} blocks IR blocks (any types)
 * @returns {Array<Record<string, unknown>>} new array, input order preserved
 */
export function assignHeadingLevels(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  /** @type {Array<Record<string, unknown>>} */
  const result = list.map((block) =>
    block && typeof block === 'object' ? { .../** @type {Record<string, unknown>} */ (block) } : /** @type {any} */ (block));

  /** @type {number[]} */
  const headingIndices = [];
  /** @type {number[]} */
  const headingSizes = [];
  for (let i = 0; i < list.length; i++) {
    const block = list[i];
    if (block && typeof block === 'object' && /** @type {{type?: unknown}} */ (block).type === 'heading') {
      const size = /** @type {{fontSize?: unknown}} */ (block).fontSize;
      headingIndices.push(i);
      headingSizes.push(typeof size === 'number' && Number.isFinite(size) ? size : 0);
    }
  }
  if (headingIndices.length === 0) return result;

  const groups = groupSizes(headingSizes, DEFAULT_TOLERANCE);
  const singleCluster = groups.length === 1;

  // `nativeLevel` only breaks ties *inside* a cluster, which fixes the order in
  // which siblings of one level are visited (all of them share the same level).
  for (const group of groups) {
    group.indices.sort((a, b) =>
      (nativeLevelOf(list[headingIndices[a]]) - nativeLevelOf(list[headingIndices[b]])) || (a - b));
  }

  for (let g = 0; g < groups.length; g++) {
    const level = singleCluster ? 2 : clamp(g + 1, MIN_HEADING_LEVEL, MAX_HEADING_LEVEL);
    for (const localIndex of groups[g].indices) {
      const target = result[headingIndices[localIndex]];
      if (target && typeof target === 'object') target.level = level;
    }
  }
  return result;
}
