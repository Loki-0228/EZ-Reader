/**
 * `<br>` line splitting. `dom/scan.js` turns each `<br>` separated line into a
 * plain-text entry of `block.lines`; this module turns those entries into real
 * blocks so the reader can style them independently.
 */

import { escapeHtml } from './constants.js';

/** A line whose predecessor ends like this continues the same sentence. @type {RegExp} */
const CONTINUES_PREV_RE = /[\p{L},-]$/u;

/** A line starting with a lowercase letter continues the previous line. @type {RegExp} */
const STARTS_LOWER_RE = /^\p{Ll}/u;

/**
 * @typedef {Object} IrBlock
 * @property {string} type
 * @property {string} html
 * @property {string} text
 * @property {number} fontSize
 * @property {number} fontWeight
 * @property {number} lineHeightPx
 * @property {string[]} [lines]
 */

/**
 * Is `next` a soft continuation of `prev` rather than a new block?
 * True when `prev` ends with a letter, a hyphen or a comma and `next` starts
 * with a lowercase letter. Surrounding whitespace is ignored.
 * @param {unknown} prev previous line (plain text)
 * @param {unknown} next following line (plain text)
 * @returns {boolean} true when the two lines belong to the same paragraph
 */
export function isContinuationLine(prev, next) {
  if (typeof prev !== 'string' || typeof next !== 'string') return false;
  const left = prev.replace(/\s+$/, '');
  const right = next.replace(/^\s+/, '');
  if (left === '' || right === '') return false;
  return CONTINUES_PREV_RE.test(left) && STARTS_LOWER_RE.test(right);
}

/**
 * Split one block on its `<br>` derived lines.
 *
 * Returns `[block]` (the very same reference) when there is nothing to split:
 * no `lines` array, one line only, or no non-empty line at all. Otherwise every
 * non-empty line becomes a new block whose `text` is that line and whose `html`
 * is the escaped line; every other field of the source block is copied over and
 * the stale `lines` array is dropped.
 *
 * @param {unknown} block IR block
 * @returns {IrBlock[]} one block per line, or `[block]` when nothing splits
 */
export function splitBlock(block) {
  if (!block || typeof block !== 'object') return /** @type {any} */ ([block]);
  // A line break inside one list item/code block must not create extra points.
  if (['li', 'code', 'table', 'quote'].includes(block.type)) return [block];
  const lines = Array.isArray(/** @type {{lines?: unknown}} */ (block).lines)
    ? /** @type {string[]} */ (/** @type {{lines: string[]}} */ (block).lines)
    : null;
  if (lines === null || lines.length <= 1) return /** @type {any} */ ([block]);

  const kept = lines.filter((line) => typeof line === 'string' && line.trim() !== '');
  if (kept.length === 0) return /** @type {any} */ ([block]);

  /** @type {Record<string, unknown>} */
  const base = { .../** @type {Record<string, unknown>} */ (block) };
  delete base.lines;
  delete base.text;
  delete base.html;
  delete base.inline;

  const splitInline = nodes => {
    const groups = [[]];
    for (const node of nodes) {
      if (node.type === 'break') { groups.push([]); continue; }
      if (Array.isArray(node.children)) {
        splitInline(node.children).forEach((children, index) => {
          if (index) groups.push([]);
          if (children.length) groups[groups.length - 1].push({ ...node, children });
        });
      } else groups[groups.length - 1].push(node);
    }
    return groups;
  };
  const inlineText = nodes => nodes.map(node => node.type === 'text' ? node.text : node.type === 'image' ? node.alt || '' : inlineText(node.children || [])).join('');
  const groups = Array.isArray(block.inline) ? splitInline(block.inline).filter(nodes => inlineText(nodes).trim()) : [];

  return kept.map((line, index) => /** @type {IrBlock} */ ({ ...base, text: line, html: escapeHtml(line),
    ...(groups.length === kept.length ? { inline: groups[index] } : {}) }));
}

/**
 * Split every block of a document, flattening the results in order.
 * @param {unknown} blocks IR blocks
 * @returns {IrBlock[]} flattened, order-preserving block list
 */
export function splitAll(blocks) {
  if (!Array.isArray(blocks)) return [];
  /** @type {IrBlock[]} */
  const out = [];
  for (const block of blocks) {
    const parts = splitBlock(block);
    for (const part of parts) out.push(part);
  }
  return out;
}
