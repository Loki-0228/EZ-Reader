/**
 * IR → DOM rendering for the reader view.
 *
 * Built with real elements and `textContent` only: no HTML string is ever
 * concatenated into the document. Text is written segment by segment through
 * `segmentForCapitalize`, so enabling "capitalize first letter" only replaces
 * the first character of eligible words and leaves URLs, e-mails, digits and
 * `iPhone` / `DNA` untouched.
 */

import { MAX_HEADING_LEVEL, MIN_HEADING_LEVEL, clamp } from './constants.js';
import { segmentRanges } from './title-case.js';

/**
 * @typedef {Object} RenderOptions
 * @property {Document} doc document used to create nodes (required)
 */

/**
 * Coerce a block text field to a string.
 * @param {unknown} value candidate
 * @returns {string} text, never null
 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Set an attribute when the node implementation supports it.
 * @param {any} node element
 * @param {string} name attribute name
 * @param {string} value attribute value
 * @returns {void}
 */
function setAttr(node, name, value) {
  if (node && typeof node.setAttribute === 'function') node.setAttribute(name, value);
}

/**
 * Create an element with a class attribute.
 * @param {any} doc document
 * @param {string} tagName tag name
 * @param {string} className class attribute value
 * @returns {any} the new element
 */
function makeElement(doc, tagName, className) {
  const node = doc.createElement(tagName);
  if (className !== '') setAttr(node, 'class', className);
  return node;
}

/**
 * Tag a block root element with its IR metadata.
 * @param {any} node element
 * @param {string} type block type
 * @param {number} index block index
 * @param {number|null} level heading level, or null
 * @returns {void}
 */
function stamp(node, type, index, level) {
  setAttr(node, 'data-ezr-type', type);
  if (level !== null && Number.isFinite(level)) setAttr(node, 'data-ezr-level', String(level));
  setAttr(node, 'data-ezr-id', String(index));
}

/**
 * @typedef {Object} InlineNode
 * @property {'text'|'element'|'image'|'break'} [type]
 * @property {string} [text]   for `type: 'text'`
 * @property {string} [tag]    for `type: 'element'`
 * @property {Record<string,string>} [attrs]
 * @property {InlineNode[]} [children]
 * @property {string} [alt]    for `type: 'image'`
 * @property {string} [src]
 */

/**
 * Tags whose text must never be capitalized (identifiers, not prose).
 * @type {ReadonlyArray<string>}
 */
const VERBATIM_TAGS = ['code', 'kbd', 'samp', 'var'];

/**
 * Append one run of prose text, honouring the capitalization setting.
 *
 * Capitalization is a rendering-time effect: the text itself is written back
 * byte-identical, and eligible words are wrapped in `span[data-ezr-w]` so that
 * `::first-letter { text-transform: uppercase }` (see styles.js) produces the
 * visual uppercase. That keeps copy/paste, find-in-page and every text-based
 * accessibility feature reading the original string.
 *
 * @param {any} doc document
 * @param {any} parent element that receives the text
 * @param {string} text prose run
 * @param {boolean} capitalize whether word initials are marked for uppercasing
 * @returns {void}
 */
function appendText(doc, parent, text, capitalize) {
  if (text === '') return;
  if (!capitalize) {
    parent.appendChild(doc.createTextNode(text));
    return;
  }
  for (const range of segmentRanges(text)) {
    const slice = text.slice(range.start, range.end);
    if (slice === '') continue;
    if (range.word && !range.skip && slice.length > 1) {
      const mark = doc.createElement('span');
      setAttr(mark, 'data-ezr-w', '');
      mark.appendChild(doc.createTextNode(slice));
      parent.appendChild(mark);
      continue;
    }
    parent.appendChild(doc.createTextNode(slice));
  }
}

/**
 * Render the sanitized inline structure captured by `dom/scan.js`.
 *
 * `dom/*` owns DOM traversal, so it is the layer that knows how to read the real
 * inline markup; this function only ever creates nodes. That keeps `core/*` free of
 * an HTML parser (and therefore unit-testable with a stub document) while still
 * reproducing inline emphasis, links, code and line breaks in the reader view.
 *
 * @param {any} doc document
 * @param {any} parent element that receives the nodes
 * @param {unknown} nodes inline node tree from the IR
 * @param {boolean} capitalize whether word initials are marked for uppercasing
 * @param {boolean} [verbatim] true while inside a code-like subtree
 * @returns {void}
 */
function appendInline(doc, parent, nodes, capitalize, verbatim = false) {
  if (!Array.isArray(nodes)) return;
  for (const rawNode of nodes) {
    if (!rawNode || typeof rawNode !== 'object') continue;
    const node = /** @type {Record<string, any>} */ (rawNode);
    const kind = typeof node.type === 'string' ? node.type : 'element';

    if (kind === 'text') {
      const value = toText(node.text);
      if (verbatim) parent.appendChild(doc.createTextNode(value));
      else appendText(doc, parent, value, capitalize);
      continue;
    }

    if (kind === 'break') {
      parent.appendChild(doc.createElement('br'));
      continue;
    }

    if (kind === 'image') {
      const alt = toText(node.alt);
      if (alt === '') continue;
      const chip = makeElement(doc, 'span', 'ezr-alt');
      setAttr(chip, 'data-ezr-alt', '');
      if (typeof node.src === 'string' && node.src !== '') setAttr(chip, 'data-ezr-src', node.src);
      chip.appendChild(doc.createTextNode(alt));
      parent.appendChild(chip);
      continue;
    }

    const tag = typeof node.tag === 'string' && node.tag !== '' ? node.tag : 'span';
    const child = doc.createElement(tag);
    if (node.attrs && typeof node.attrs === 'object') {
      for (const [name, value] of Object.entries(node.attrs)) {
        if (typeof value === 'string') setAttr(child, name, value);
      }
    }
    appendInline(doc, child, node.children, capitalize, verbatim || VERBATIM_TAGS.includes(tag));
    parent.appendChild(child);
  }
}

/**
 * Fill a block element with its content: the inline tree when the IR provides one,
 * otherwise the flattened text.
 *
 * @param {any} doc document
 * @param {any} parent block element
 * @param {Record<string, any>} block IR block
 * @param {boolean} capitalize whether word initials are marked for uppercasing
 * @returns {void}
 */
function appendContent(doc, parent, block, capitalize, allowBreaks = true) {
  if (Array.isArray(block.inline) && block.inline.length > 0) {
    appendInline(doc, parent, block.inline, capitalize);
    return;
  }
  const lines =
    allowBreaks && Array.isArray(block.lines)
      ? block.lines.filter((line) => typeof line === 'string' && line.trim() !== '')
      : [];
  if (lines.length > 1) {
    // The source block used <br> as its own paragraph separator, and scan.js kept the
    // lines instead of splitting. Preserve the visual line structure.
    lines.forEach((line, i) => {
      if (i > 0) parent.appendChild(doc.createElement('br'));
      appendText(doc, parent, line, capitalize);
    });
    return;
  }
  appendText(doc, parent, toText(block.text), capitalize);
}

/**
 * Render a single IR block into its element.
 * @param {any} doc document
 * @param {unknown} block IR block
 * @param {number} index block index
 * @param {boolean} capitalize whether word initials are uppercased
 * @returns {any} the block root element
 */
function renderBlock(doc, block, index, capitalize) {
  const b = block && typeof block === 'object' ? /** @type {Record<string, unknown>} */ (block) : {};
  const type = typeof b.type === 'string' && b.type !== '' ? b.type : 'para';
  const text = toText(b.text);

  if (type === 'heading') {
    const raw = typeof b.level === 'number' && Number.isFinite(b.level) ? b.level : 2;
    const level = clamp(Math.trunc(raw), MIN_HEADING_LEVEL, MAX_HEADING_LEVEL);
    const heading = makeElement(doc, `h${level}`, `ezr-h${level}`);
    stamp(heading, 'heading', index, level);
    appendContent(doc, heading, b, capitalize);
    return heading;
  }

  if (type === 'li') {
    const list = makeElement(doc, b.listKind === 'ol' ? 'ol' : 'ul', 'ezr-list');
    const item = makeElement(doc, 'li', 'ezr-li');
    if (b.listKind === 'ol' && Number.isFinite(b.listValue)) item.setAttribute('value', String(b.listValue));
    if (b.listReversed) list.setAttribute('reversed', '');
    stamp(item, 'li', index, null);
    appendContent(doc, item, b, capitalize);
    list.appendChild(item);
    return list;
  }

  if (type === 'quote') {
    const quote = makeElement(doc, 'blockquote', 'ezr-quote');
    stamp(quote, 'quote', index, null);
    appendContent(doc, quote, b, capitalize);
    return quote;
  }

  if (type === 'code') {
    const pre = makeElement(doc, 'pre', 'ezr-code');
    const code = doc.createElement('code');
    // Code is verbatim: never capitalized, never restructured.
    code.appendChild(doc.createTextNode(text));
    pre.appendChild(code);
    stamp(pre, 'code', index, null);
    return pre;
  }

  if (type === 'table') {
    const wrap = makeElement(doc, 'div', 'ezr-table-wrap');
    const table = doc.createElement('table');
    const body = doc.createElement('tbody');
    const row = doc.createElement('tr');
    const cell = doc.createElement('td');
    appendContent(doc, cell, b, capitalize);
    row.appendChild(cell);
    body.appendChild(row);
    table.appendChild(body);
    wrap.appendChild(table);
    stamp(wrap, 'table', index, null);
    return wrap;
  }

  if (type === 'hr') {
    const rule = makeElement(doc, 'hr', 'ezr-hr');
    stamp(rule, 'hr', index, null);
    return rule;
  }

  const paragraph = makeElement(doc, 'p', 'ezr-para');
  stamp(paragraph, type === 'figure' ? 'figure' : 'para', index, null);
  appendContent(doc, paragraph, b, capitalize);
  return paragraph;
}

/**
 * Render an already classified IR document into a DocumentFragment.
 *
 * Output shape: `div.ezr-article` containing `h1..h6.ezr-h1..h6`,
 * `p.ezr-para`, `ul.ezr-list > li.ezr-li`, `blockquote.ezr-quote`,
 * `pre.ezr-code > code`, `div.ezr-table-wrap > table` and `hr.ezr-hr`.
 * Every block root carries `data-ezr-type`, `data-ezr-id` and — for headings —
 * `data-ezr-level`.
 *
 * @param {unknown} irDoc IR document (`{ blocks, body, title, truncated }`)
 * @param {Record<string, unknown>} [settings] settings; `capitalizeFirst` is honoured
 * @param {RenderOptions} opts `{ doc }`
 * @returns {any} DocumentFragment holding the rendered article
 * @throws {Error} `renderDoc: no document` when `opts.doc` is missing
 */
export function renderDoc(irDoc, settings, opts) {
  const doc = opts && typeof opts === 'object' ? opts.doc : null;
  if (!doc || typeof doc.createElement !== 'function' || typeof doc.createDocumentFragment !== 'function') {
    throw new Error('renderDoc: no document');
  }
  const fragment = doc.createDocumentFragment();
  const article = makeElement(doc, 'div', 'ezr-article');
  fragment.appendChild(article);

  const blocks = irDoc && typeof irDoc === 'object' && Array.isArray(/** @type {any} */ (irDoc).blocks)
    ? /** @type {unknown[]} */ (/** @type {any} */ (irDoc).blocks)
    : [];
  const capitalize = Boolean(settings && typeof settings === 'object' && settings.capitalizeFirst === true);

  let lastList = null, lastListId = null;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const node = renderBlock(doc, block, index, capitalize);
    const listId = block?.type === 'li' && block.listId ? `${block.listKind || 'ul'}:${block.listId}` : null;
    if (listId && listId === lastListId && lastList) lastList.appendChild(node.childNodes[0]);
    else article.appendChild(node);
    lastList = listId ? (listId === lastListId ? lastList : node) : null;
    lastListId = listId;
  }
  return fragment;
}

/**
 * Outline of an IR document: one entry per heading block.
 * @param {unknown} irDoc IR document
 * @returns {Array<{id: number, level: number, text: string}>} heading entries in reading order
 */
export function blocksToOutline(irDoc) {
  const blocks = irDoc && typeof irDoc === 'object' && Array.isArray(/** @type {any} */ (irDoc).blocks)
    ? /** @type {unknown[]} */ (/** @type {any} */ (irDoc).blocks)
    : [];
  /** @type {Array<{id: number, level: number, text: string}>} */
  const outline = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block || typeof block !== 'object' || /** @type {any} */ (block).type !== 'heading') continue;
    const raw = typeof /** @type {any} */ (block).level === 'number' && Number.isFinite(/** @type {any} */ (block).level)
      ? /** @type {any} */ (block).level
      : 2;
    outline.push({
      id: index,
      level: clamp(Math.trunc(raw), MIN_HEADING_LEVEL, MAX_HEADING_LEVEL),
      text: toText(/** @type {any} */ (block).text),
    });
  }
  return outline;
}
