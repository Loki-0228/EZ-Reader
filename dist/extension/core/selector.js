/**
 * Stable CSS path helpers for source-node back links (`IrBlock.srcPath`).
 */

/** Max ancestor hops (defensive guard against cycles). @type {number} */
const MAX_DEPTH = 200;

/** Fallback CSS identifier test, used when `CSS.escape` is unavailable. @type {RegExp} */
const SIMPLE_IDENT_RE = /^-?[_A-Za-z][_A-Za-z0-9-]*$/;

/**
 * Lowercase tag name of an element-ish node.
 * @param {any} el element
 * @returns {string} lowercase tag name, or ''
 */
function tagNameOf(el) {
  if (!el || typeof el !== 'object') return '';
  const raw = typeof el.tagName === 'string' && el.tagName !== ''
    ? el.tagName
    : (typeof el.nodeName === 'string' ? el.nodeName : '');
  return raw.toLowerCase();
}

/**
 * Build `#id` when the id is usable as a CSS identifier, otherwise ''.
 * @param {string} id raw id
 * @returns {string} a `#id` selector, or ''
 */
function idSelector(id) {
  const css = typeof globalThis !== 'undefined' ? /** @type {any} */ (globalThis).CSS : null;
  if (css && typeof css.escape === 'function') {
    try {
      return `#${css.escape(id)}`;
    } catch {
      /* fall through to the simple test */
    }
  }
  return SIMPLE_IDENT_RE.test(id) ? `#${id}` : '';
}

/**
 * 1-based `:nth-of-type()` index of `el` among its same-tag siblings.
 * Returns 1 when the sibling list is not observable.
 * @param {any} el element
 * @param {any} parent parent element, or null
 * @param {string} tag lowercase tag name
 * @returns {number} 1-based index
 */
function childIndex(el, parent, tag) {
  if (!parent || typeof parent !== 'object') return 1;

  const children = Array.isArray(parent.children) ? parent.children : null;
  if (children !== null) {
    let index = 0;
    for (const child of children) {
      if (child && typeof child === 'object' && tagNameOf(child) === tag) {
        index += 1;
        if (child === el) return index;
      }
    }
    return 1;
  }

  let index = 1;
  let guard = 0;
  let prev = el && typeof el === 'object' ? el.previousElementSibling : null;
  while (prev && typeof prev === 'object' && guard < MAX_DEPTH) {
    guard += 1;
    if (tagNameOf(prev) === tag) index += 1;
    prev = prev.previousElementSibling;
  }
  return index;
}

/**
 * Stable CSS path of an element, used to find the source node again later.
 *
 * The walk starts at `el` and stops at (never including) `stopAt`, when an
 * ancestor exposes an id (ids are unique, so `#id` is already stable) or at the
 * document root. Segments use `tag` or `tag:nth-of-type(n)` when the sibling
 * list is observable and the element is not the first of its type.
 *
 * @param {{id?: string, tagName?: string, parentElement?: any}} el element-ish node
 * @param {any} [stopAt] ancestor to stop before (the extraction root)
 * @returns {string} CSS path such as `#main > div > p:nth-of-type(2)`
 */
export function cssPath(el, stopAt) {
  if (!el || typeof el !== 'object') return '';
  /** @type {string[]} */
  const parts = [];
  let node = /** @type {any} */ (el);
  let depth = 0;

  while (node && typeof node === 'object' && node !== stopAt && depth < MAX_DEPTH) {
    depth += 1;
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (id !== '') {
      const selector = idSelector(id);
      if (selector !== '') {
        parts.unshift(selector);
        break;
      }
    }
    const tag = tagNameOf(node);
    if (tag === '') break;
    const parent = node.parentElement && typeof node.parentElement === 'object' ? node.parentElement : null;
    const index = childIndex(node, parent, tag);
    parts.unshift(index > 1 ? `${tag}:nth-of-type(${index})` : tag);
    node = parent;
  }
  return parts.join(' > ');
}

/**
 * Is this a usable stored path?
 * @param {unknown} path candidate path
 * @returns {boolean} true for a non-empty string without line breaks
 */
export function isValidPath(path) {
  return typeof path === 'string' && path.length > 0 && !/[\r\n]/.test(path);
}
