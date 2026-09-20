/**
 * Inline HTML sanitizer.
 *
 * It serializes a subtree to a safe HTML string by walking the DOM itself —
 * `innerHTML` / `outerHTML` are never read. The DOM is injectable (`opts.doc`)
 * so the whole module is unit-testable with a tiny stub.
 *
 * Only this DOM surface is used: `nodeType`, `nodeName`, `childNodes`,
 * `textContent`, `getAttribute(name)`.
 */

import { escapeHtml } from './constants.js';

/** Inline elements that survive sanitization. @type {ReadonlySet<string>} */
const ALLOWED_ELEMENTS = new Set([
  'a', 'strong', 'b', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small', 'abbr', 'span', 'code', 'kbd', 'samp', 'var', 'br', 'img',
]);

/** Elements dropped together with all of their content. @type {ReadonlySet<string>} */
const DROPPED_ELEMENTS = new Set(['script', 'style', 'iframe', 'svg']);

/** Attributes kept per element; every other attribute is stripped. @type {Readonly<Record<string, ReadonlyArray<string>>>} */
const ALLOWED_ATTRS = Object.freeze({
  a: Object.freeze(['href', 'title']),
  abbr: Object.freeze(['title']),
  span: Object.freeze([]),
  code: Object.freeze([]),
});

/** URL schemes that must never survive. @type {ReadonlyArray<string>} */
const DANGEROUS_SCHEMES = Object.freeze(['javascript:', 'data:', 'vbscript:']);

/** Guard against pathological nesting. @type {number} */
const MAX_DEPTH = 100;

/**
 * @typedef {Object} SanitizeOptions
 * @property {Document} [doc]      DOM implementation; defaults to `globalThis.document`
 * @property {boolean} [dropUrlText] drop anchor text that is itself a URL
 */

/**
 * Resolve the DOM implementation or fail loudly.
 * @param {SanitizeOptions} [opts] sanitizer options
 * @returns {any} the document to use
 */
function resolveDoc(opts) {
  const fromOpts = opts && typeof opts === 'object' ? opts.doc : null;
  const doc = fromOpts || (typeof globalThis !== 'undefined' ? globalThis.document : null);
  if (!doc) throw new Error('sanitizeInline: no document');
  return doc;
}

/**
 * Lowercase tag name of an element node.
 * @param {any} node element node
 * @returns {string} lowercase tag name, or '' when unknown
 */
function tagNameOf(node) {
  if (!node || typeof node !== 'object') return '';
  const raw = typeof node.nodeName === 'string' && node.nodeName !== ''
    ? node.nodeName
    : (typeof node.tagName === 'string' ? node.tagName : (typeof node.localName === 'string' ? node.localName : ''));
  return raw.toLowerCase();
}

/**
 * Text content of a node without ever reading HTML.
 * @param {any} node any node
 * @returns {string} text content, or ''
 */
function textOf(node) {
  if (!node || typeof node !== 'object') return '';
  return typeof node.textContent === 'string' ? node.textContent : '';
}

/**
 * Read an attribute defensively.
 * @param {any} el element node
 * @param {string} name attribute name
 * @returns {string|null} attribute value, or null when absent
 */
function getAttr(el, name) {
  if (!el || typeof el.getAttribute !== 'function') return null;
  const value = el.getAttribute(name);
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Does this href use a script-capable scheme? Case and whitespace insensitive.
 * @param {string} href raw href
 * @returns {boolean} true when the URL must be neutralized
 */
function isDangerousUrl(href) {
  const normalized = String(href).replace(/[\u0000-\u0020\u007F-\u00A0]+/g, '').toLowerCase();
  return DANGEROUS_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

/**
 * Base URL of the injected document, when it exposes one.
 * @param {any} doc document (or stub)
 * @returns {string} base URL, or '' when unknown
 */
function baseUrlOf(doc) {
  if (!doc || typeof doc !== 'object') return '';
  const candidates = [doc.baseURI, doc.URL, doc.location && doc.location.href];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return '';
}

/**
 * Resolve an href against the document base. When the environment cannot parse
 * URLs (a stub without a base) the original value is kept.
 * @param {string} href raw href
 * @param {any} doc document (or stub)
 * @returns {string} absolute URL when possible, otherwise the original value
 */
function resolveUrl(href, doc) {
  const raw = String(href).trim();
  if (raw === '') return raw;
  const URLImpl = typeof globalThis !== 'undefined' ? globalThis.URL : undefined;
  if (typeof URLImpl !== 'function') return raw;
  const base = baseUrlOf(doc);
  try {
    return base === '' ? new URLImpl(raw).href : new URLImpl(raw, base).href;
  } catch {
    return raw;
  }
}

/**
 * Does this text look like a bare URL?
 * @param {string} text text to test
 * @returns {boolean} true when the text is URL shaped
 */
function looksLikeUrl(text) {
  const trimmed = text.trim();
  return trimmed.includes('://') || /^www\./i.test(trimmed);
}

/**
 * Serialize every child of a node.
 * @param {any} node parent node
 * @param {any} doc document
 * @param {SanitizeOptions} options sanitizer options
 * @param {number} depth current recursion depth
 * @returns {string} sanitized HTML of the children
 */
function serializeChildren(node, doc, options, depth) {
  const children = node && node.childNodes ? node.childNodes : null;
  if (!children || typeof children.length !== 'number') return '';
  let out = '';
  for (let i = 0; i < children.length; i++) {
    out += serialize(children[i], doc, options, depth + 1);
  }
  return out;
}

/**
 * Serialize an `<a>` element.
 * @param {any} el anchor element
 * @param {string} children already sanitized children
 * @param {any} doc document
 * @param {SanitizeOptions} options sanitizer options
 * @returns {string} safe HTML
 */
function serializeAnchor(el, children, doc, options) {
  const href = getAttr(el, 'href');
  const title = getAttr(el, 'title');
  if (options.dropUrlText === true && looksLikeUrl(textOf(el))) return '';
  if (href === null || href === '' || isDangerousUrl(href)) return children;

  const parts = [` href="${escapeHtml(resolveUrl(href, doc))}"`];
  if (title !== null && title !== '') parts.push(` title="${escapeHtml(title)}"`);
  return `<a${parts.join('')}>${children}</a>`;
}

/**
 * Serialize the allowed attributes of an element.
 * @param {any} el element node
 * @param {string} tag lowercase tag name
 * @returns {string} attribute string (leading space included), or ''
 */
function renderAttrs(el, tag) {
  const names = ALLOWED_ATTRS[tag];
  if (!names || names.length === 0) return '';
  const parts = [];
  for (const name of names) {
    const value = getAttr(el, name);
    if (value !== null && value !== '') parts.push(` ${name}="${escapeHtml(value)}"`);
  }
  return parts.join('');
}

/**
 * Serialize an element node.
 * @param {any} el element node
 * @param {any} doc document
 * @param {SanitizeOptions} options sanitizer options
 * @param {number} depth current recursion depth
 * @returns {string} safe HTML
 */
function serializeElement(el, doc, options, depth) {
  const tag = tagNameOf(el);
  if (tag === '') return serializeChildren(el, doc, options, depth);
  if (DROPPED_ELEMENTS.has(tag)) return '';
  if (tag === 'br') return '<br>';
  if (tag === 'img') return serializeImage(el, doc);
  if (!ALLOWED_ELEMENTS.has(tag)) return serializeChildren(el, doc, options, depth);

  const children = serializeChildren(el, doc, options, depth);
  if (tag === 'a') return serializeAnchor(el, children, doc, options);
  return `<${tag}${renderAttrs(el, tag)}>${children}</${tag}>`;
}

/**
 * Serialize an `<img>` as a text placeholder.
 *
 * The reader is offline and text-first, so an image never becomes a loadable element:
 * its `alt` text is the content, and the address is kept only as `data-ezr-src`, which
 * nothing ever fetches. Images without `alt` carry no readable information and vanish.
 *
 * @param {any} el image element
 * @param {any} doc document
 * @returns {string} safe placeholder markup
 */
function serializeImage(el, doc) {
  const alt = getAttr(el, 'alt');
  if (alt === null || alt.trim() === '') return '';
  const src = getAttr(el, 'src');
  const attrs = [` data-ezr-alt=""`];
  if (src !== null && src !== '' && !isDangerousUrl(src)) {
    attrs.push(` data-ezr-src="${escapeHtml(resolveUrl(src, doc))}"`);
  }
  return `<span class="ezr-alt"${attrs.join('')}>${escapeHtml(alt)}</span>`;
}

/**
 * Serialize one node (text, element, document or fragment).
 * @param {any} node node to serialize
 * @param {any} doc document
 * @param {SanitizeOptions} options sanitizer options
 * @param {number} depth current recursion depth
 * @returns {string} safe HTML
 */
function serialize(node, doc, options, depth) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return '';
  const nodeType = node.nodeType;
  if (nodeType === 3) return escapeHtml(textOf(node));
  if (nodeType === 1) return serializeElement(node, doc, options, depth);
  if (nodeType === 9 || nodeType === 11) return serializeChildren(node, doc, options, depth);
  return '';
}

/**
 * Sanitize one inline node subtree into HTML.
 *
 * Whitelisted elements keep their tag; `<script>`, `<style>`, `<iframe>` and
 * `<svg>` disappear together with their content; every other element is
 * unwrapped (children kept, text escaped). `<a>` loses its tag when the href
 * uses `javascript:`, `data:` or `vbscript:`, and surviving hrefs are resolved
 * to absolute URLs when the document exposes a base.
 *
 * @param {any} node node (or subtree root) to sanitize
 * @param {SanitizeOptions} [opts] `{ doc, dropUrlText }`
 * @returns {string} sanitized HTML
 * @throws {Error} `sanitizeInline: no document` when no DOM is available
 */
export function sanitizeInline(node, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const doc = resolveDoc(options);
  return serialize(node, doc, options, 0);
}

/**
 * Convenience wrapper: sanitize the whole subtree *inside* `root` (the root's
 * own tag is not emitted, so a block element yields its inline HTML).
 *
 * @param {any} root container node (element, fragment or document)
 * @param {SanitizeOptions} [opts] `{ doc, dropUrlText }`
 * @returns {string} sanitized HTML of the subtree
 * @throws {Error} `sanitizeInline: no document` when no DOM is available
 */
export function sanitizeAll(root, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const doc = resolveDoc(options);
  if (!root || typeof root !== 'object') return '';
  const nodeType = root.nodeType;
  if (nodeType === 1) {
    if (DROPPED_ELEMENTS.has(tagNameOf(root))) return '';
    return serializeChildren(root, doc, options, 0);
  }
  if (nodeType === 9 || nodeType === 11) return serializeChildren(root, doc, options, 0);
  return serialize(root, doc, options, 0);
}

/**
 * Convert a DOM subtree into the atomic inline tree consumed by `core/render.js`.
 *
 * This is the same whitelist, the same attribute policy and the same href rules as
 * {@link sanitizeInline}, but expressed as plain data instead of an HTML string. That
 * matters because `core/render.js` must not parse HTML: it builds nodes with
 * `createElement`/`textContent`, so the sanitizer has to hand it a structure it can
 * construct directly. The two functions are kept behaviourally identical on purpose —
 * images become `alt` placeholders, `script`/`style`/`iframe`/`svg` vanish with their
 * content, and everything else is unwrapped.
 *
 * @param {any} root container whose CHILDREN are converted (its own tag is not emitted)
 * @param {SanitizeOptions} [opts] `{ doc, dropUrlText }`
 * @returns {Array<Object>} inline nodes: `{type:'text'|'element'|'image'|'break', ...}`
 * @throws {Error} `sanitizeInline: no document` when no DOM is available
 */
export function inlineNodes(root, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const doc = resolveDoc(options);
  if (!root || typeof root !== 'object') return [];
  const nodeType = root.nodeType;
  if (nodeType === 1) {
    if (DROPPED_ELEMENTS.has(tagNameOf(root))) return [];
    return inlineChildren(root, doc, options, 0);
  }
  if (nodeType === 9 || nodeType === 11) return inlineChildren(root, doc, options, 0);
  const single = inlineNode(root, doc, options, 0);
  return single === null ? [] : [single];
}

/**
 * Convert a node's children.
 * @param {any} node parent node
 * @param {any} doc document
 * @param {SanitizeOptions} options sanitizer options
 * @param {number} depth current depth
 * @returns {Array<Object>} inline nodes
 */
function inlineChildren(node, doc, options, depth) {
  if (depth > MAX_DEPTH) return [];
  const out = [];
  const kids = node && node.childNodes ? node.childNodes : null;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    const child = inlineNode(kids[i], doc, options, depth);
    if (child !== null) out.push(child);
  }
  return out;
}

/**
 * Convert one node.
 * @param {any} node node to convert
 * @param {any} doc document
 * @param {SanitizeOptions} options sanitizer options
 * @param {number} depth current depth
 * @returns {Object|null} inline node, or null when the node contributes nothing
 */
function inlineNode(node, doc, options, depth) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return null;
  const nodeType = node.nodeType;

  if (nodeType === 3) {
    const text = textOf(node);
    return text === '' ? null : { type: 'text', text };
  }
  if (nodeType === 9 || nodeType === 11) {
    return { type: 'element', tag: 'span', attrs: {}, children: inlineChildren(node, doc, options, depth + 1) };
  }
  if (nodeType !== 1) return null;

  const tag = tagNameOf(node);
  if (tag === '' || DROPPED_ELEMENTS.has(tag)) return null;
  if (tag === 'br') return { type: 'break' };

  if (tag === 'img') {
    const alt = getAttr(node, 'alt');
    if (alt === null || alt.trim() === '') return null;
    /** @type {Object} */
    const image = { type: 'image', alt };
    const src = getAttr(node, 'src');
    if (src !== null && src !== '' && !isDangerousUrl(src)) image.src = resolveUrl(src, doc);
    return image;
  }

  const children = inlineChildren(node, doc, options, depth + 1);
  if (!ALLOWED_ELEMENTS.has(tag)) {
    // Unwrap: the element disappears, its content stays, in document order.
    return { type: 'element', tag: 'span', attrs: {}, children };
  }

  if (tag === 'a') {
    if (options.dropUrlText === true && /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(textOf(node).trim())) {
      return { type: 'element', tag: 'span', attrs: {}, children };
    }
    const href = getAttr(node, 'href');
    const attrs = {};
    if (href !== null && href !== '' && !isDangerousUrl(href)) {
      attrs.href = resolveUrl(href, doc);
      const title = getAttr(node, 'title');
      if (title !== null && title !== '') attrs.title = title;
    }
    return { type: 'element', tag: 'a', attrs, children };
  }

  const attrs = {};
  const allowed = ALLOWED_ATTRS[tag];
  if (allowed) {
    for (const name of allowed) {
      const value = getAttr(node, name);
      if (value !== null && value !== '') attrs[name] = value;
    }
  }
  return { type: 'element', tag, attrs, children };
}
