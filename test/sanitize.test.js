import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeAll, sanitizeInline } from '../src/core/sanitize.js';

/**
 * Minimal DOM stub (CONTRACTS.md §10): nodeType / nodeName / childNodes /
 * textContent / getAttribute only. Every DOM surface the sanitizer is NOT
 * allowed to touch throws, so an accidental `innerHTML` or `classList` access
 * fails loudly instead of silently passing.
 * @param {string} nodeName tag name (any case)
 * @param {Record<string, string>} [attrs] attributes
 * @param {any[]} [children] child nodes
 * @returns {any} stub element
 */
function makeNode(nodeName, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    nodeName: nodeName.toUpperCase(),
    childNodes: children,
    attributes: { ...attrs },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
  Object.defineProperties(node, {
    textContent: { get() { return this.childNodes.map((child) => child.textContent).join(''); } },
    innerHTML: { get() { throw new Error('innerHTML must never be read'); } },
    outerHTML: { get() { throw new Error('outerHTML must never be read'); } },
    classList: { get() { throw new Error('classList must never be used'); } },
    style: { get() { throw new Error('style must never be used'); } },
    cloneNode: { value() { throw new Error('cloneNode must never be used'); } },
    querySelectorAll: { value() { throw new Error('querySelectorAll must never be used'); } },
  });
  return node;
}

/**
 * Stub text node.
 * @param {string} text raw text
 * @returns {any} stub text node
 */
function makeText(text) {
  return { nodeType: 3, nodeName: '#text', childNodes: [], textContent: String(text) };
}

/** Document stub with a base URI, so relative hrefs can be resolved. */
const DOC = { baseURI: 'https://example.com/post/1' };

/** Document stub without any base information at all. */
const BARE_DOC = {};

test('whitelisted elements keep their tag', () => {
  const tags = ['strong', 'b', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small', 'abbr', 'span', 'code', 'kbd', 'samp', 'var'];
  for (const tag of tags) {
    const node = makeNode(tag, {}, [makeText('x')]);
    assert.equal(sanitizeInline(node, { doc: DOC }), `<${tag}>x</${tag}>`, `${tag} must survive`);
  }
  assert.equal(sanitizeInline(makeNode('br'), { doc: DOC }), '<br>');
});

test('nested whitelisted markup is preserved in order', () => {
  const root = makeNode('span', {}, [
    makeText('a '),
    makeNode('strong', {}, [makeText('bold'), makeNode('em', {}, [makeText(' both')])]),
    makeText(' c'),
  ]);
  assert.equal(sanitizeAll(root, { doc: DOC }), 'a <strong>bold<em> both</em></strong> c');
});

test('unknown elements are unwrapped but keep their children', () => {
  const root = makeNode('div', {}, [
    makeText('one '),
    makeNode('section', {}, [makeText('two '), makeNode('span', {}, [makeText('three')])]),
  ]);
  assert.equal(sanitizeAll(root, { doc: DOC }), 'one two <span>three</span>');
  assert.equal(sanitizeInline(makeNode('p', {}, [makeText('hi')]), { doc: DOC }), 'hi', 'the root tag itself is not a whitelist member');
});

test('images become an alt placeholder and never a loadable element', () => {
  // The reader is offline and text-first: an image contributes its alt text only, and
  // the address is kept in a data attribute that nothing ever fetches.
  const withAlt = makeNode('div', {}, [makeNode('img', { src: 'x.png', alt: 'a chart' })]);
  const html = sanitizeAll(withAlt, { doc: DOC });
  assert.ok(html.includes('a chart'), 'alt text must be kept');
  assert.ok(html.includes('data-ezr-alt'), 'placeholder marker must be present');
  assert.ok(!/<img/i.test(html), 'no img element may be emitted');
  assert.ok(!/\ssrc=/.test(html), 'no loadable src attribute may be emitted');

  // A dangerous scheme must not survive even in the inert data attribute.
  const evil = makeNode('div', {}, [makeNode('img', { src: 'javascript:alert(1)', alt: 'evil' })]);
  assert.ok(!sanitizeAll(evil, { doc: DOC }).includes('javascript:'), 'dangerous src must be dropped');

  // Without alt there is no readable content at all.
  assert.equal(sanitizeAll(makeNode('div', {}, [makeNode('img', { src: 'x.png' })]), { doc: DOC }), '');
});

test('script, style, iframe and svg are dropped together with their content', () => {
  for (const tag of ['script', 'style', 'iframe', 'svg']) {
    assert.equal(sanitizeInline(makeNode(tag, {}, [makeText('danger')]), { doc: DOC }), '', `${tag} must vanish`);
    const nested = makeNode('span', {}, [makeText('a'), makeNode(tag, {}, [makeText('danger')]), makeText('b')]);
    assert.equal(sanitizeAll(nested, { doc: DOC }), 'ab');
  }
  assert.equal(sanitizeAll(makeNode('script', {}, [makeText('x')]), { doc: DOC }), '');
});

test('only whitelisted attributes survive', () => {
  const span = makeNode('span', {
    class: 'x',
    id: 'y',
    style: 'color:red',
    onclick: 'hack()',
    onmouseover: 'hack()',
    'data-evil': '1',
  }, [makeText('t')]);
  assert.equal(sanitizeInline(span, { doc: DOC }), '<span>t</span>');

  const abbr = makeNode('abbr', { title: 'HyperText Markup Language', class: 'nope' }, [makeText('HTML')]);
  assert.equal(sanitizeInline(abbr, { doc: DOC }), '<abbr title="HyperText Markup Language">HTML</abbr>');

  const code = makeNode('code', { title: 'dropped', class: 'x' }, [makeText('a')]);
  assert.equal(sanitizeInline(code, { doc: DOC }), '<code>a</code>');
});

test('anchors keep href and title, with the href resolved against the document', () => {
  const relative = makeNode('a', { href: '/next', title: 'Next' }, [makeText('next')]);
  assert.equal(sanitizeInline(relative, { doc: DOC }), '<a href="https://example.com/next" title="Next">next</a>');

  const fragment = makeNode('a', { href: '#part' }, [makeText('part')]);
  assert.equal(sanitizeInline(fragment, { doc: DOC }), '<a href="https://example.com/post/1#part">part</a>');

  const absolute = makeNode('a', { href: 'mailto:a@b.c' }, [makeText('mail')]);
  assert.equal(sanitizeInline(absolute, { doc: DOC }), '<a href="mailto:a@b.c">mail</a>');

  const extra = makeNode('a', { href: '/x', onclick: 'hack()', class: 'c', target: '_blank' }, [makeText('x')]);
  assert.equal(sanitizeInline(extra, { doc: DOC }), '<a href="https://example.com/x">x</a>');
});

test('hrefs are kept verbatim when the environment cannot resolve them', () => {
  const relative = makeNode('a', { href: '/next' }, [makeText('next')]);
  assert.equal(sanitizeInline(relative, { doc: BARE_DOC }), '<a href="/next">next</a>');
  const absolute = makeNode('a', { href: 'https://x.dev/a' }, [makeText('a')]);
  assert.equal(sanitizeInline(absolute, { doc: BARE_DOC }), '<a href="https://x.dev/a">a</a>');
});

test('javascript:, data: and vbscript: hrefs degrade the anchor to plain text', () => {
  const payloads = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'JAVASCRIPT\u0000:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'DATA:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'VBScript:msgbox(1)',
  ];
  for (const href of payloads) {
    const anchor = makeNode('a', { href, title: 't' }, [makeText('click'), makeNode('em', {}, [makeText(' me')])]);
    assert.equal(sanitizeInline(anchor, { doc: DOC }), 'click<em> me</em>', `unsafe href survived: ${href}`);
  }
});

test('anchors without an href are unwrapped', () => {
  const anchor = makeNode('a', {}, [makeText('plain')]);
  assert.equal(sanitizeInline(anchor, { doc: DOC }), 'plain');
  const emptyHref = makeNode('a', { href: '' }, [makeText('plain')]);
  assert.equal(sanitizeInline(emptyHref, { doc: DOC }), 'plain');
});

test('text nodes are escaped', () => {
  const root = makeNode('span', {}, [makeText('<script>alert("x")</script> & more')]);
  assert.equal(
    sanitizeAll(root, { doc: DOC }),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more',
  );
  assert.equal(sanitizeInline(makeText('<b>'), { doc: DOC }), '&lt;b&gt;');
  assert.equal(sanitizeInline(makeText("it's"), { doc: DOC }), 'it&#39;s');
});

test('attribute values are escaped too', () => {
  const abbr = makeNode('abbr', { title: 'a "quoted" <tag> & more' }, [makeText('x')]);
  assert.equal(sanitizeInline(abbr, { doc: DOC }), '<abbr title="a &quot;quoted&quot; &lt;tag&gt; &amp; more">x</abbr>');
});

test('dropUrlText removes anchor text that is itself a URL', () => {
  const urlAnchor = makeNode('a', { href: '/x' }, [makeText('https://x.dev/a_b')]);
  assert.equal(sanitizeInline(urlAnchor, { doc: DOC, dropUrlText: true }), '');
  assert.equal(sanitizeInline(urlAnchor, { doc: DOC, dropUrlText: false }), '<a href="https://example.com/x">https://x.dev/a_b</a>');
  assert.equal(sanitizeInline(urlAnchor, { doc: DOC }), '<a href="https://example.com/x">https://x.dev/a_b</a>');

  const wwwAnchor = makeNode('a', { href: '/y' }, [makeText('www.example.com')]);
  assert.equal(sanitizeInline(wwwAnchor, { doc: DOC, dropUrlText: true }), '');

  const normalAnchor = makeNode('a', { href: '/z' }, [makeText('Click here')]);
  assert.equal(sanitizeInline(normalAnchor, { doc: DOC, dropUrlText: true }), '<a href="https://example.com/z">Click here</a>');

  const dangerousUrlText = makeNode('a', { href: 'javascript:alert(1)' }, [makeText('https://x.dev/a')]);
  assert.equal(sanitizeInline(dangerousUrlText, { doc: DOC, dropUrlText: true }), '', 'unsafe href plus URL text disappears');
  assert.equal(sanitizeInline(dangerousUrlText, { doc: DOC }), 'https://x.dev/a', 'otherwise the text degrades to plain text');
});

test('comments and other non text/element nodes are dropped', () => {
  const comment = { nodeType: 8, nodeName: '#comment', childNodes: [], textContent: 'secret' };
  const root = makeNode('span', {}, [makeText('a'), comment, makeText('b')]);
  assert.equal(sanitizeAll(root, { doc: DOC }), 'ab');
  assert.equal(sanitizeInline(comment, { doc: DOC }), '');
  assert.equal(sanitizeInline({ nodeType: 12, nodeName: '#cdata-section', childNodes: [], textContent: 'x' }, { doc: DOC }), '');
});

test('sanitizeAll sanitizes the subtree inside the root', () => {
  const container = makeNode('div', { class: 'block' }, [
    makeNode('strong', {}, [makeText('Title')]),
    makeNode('br'),
    makeText('body'),
  ]);
  assert.equal(sanitizeAll(container, { doc: DOC }), '<strong>Title</strong><br>body');

  const fragment = { nodeType: 11, nodeName: '#document-fragment', childNodes: [makeNode('em', {}, [makeText('x')])] };
  assert.equal(sanitizeAll(fragment, { doc: DOC }), '<em>x</em>');
  assert.equal(sanitizeInline(fragment, { doc: DOC }), '<em>x</em>');

  assert.equal(sanitizeAll(null, { doc: DOC }), '');
  assert.equal(sanitizeAll(undefined, { doc: DOC }), '');
  assert.equal(sanitizeAll(makeText('a<b'), { doc: DOC }), 'a&lt;b');
  assert.equal(sanitizeInline(null, { doc: DOC }), '');
  assert.equal(sanitizeInline(42, { doc: DOC }), '');
});

test('sanitizeAll on a dropped root returns nothing', () => {
  assert.equal(sanitizeAll(makeNode('script', {}, [makeText('alert(1)')]), { doc: DOC }), '');
  assert.equal(sanitizeAll(makeNode('svg', {}, [makeNode('text', {}, [makeText('x')])]), { doc: DOC }), '');
});

test('a missing document throws the documented error', () => {
  assert.throws(() => sanitizeInline(makeText('x')), /sanitizeInline: no document/);
  assert.throws(() => sanitizeInline(makeText('x'), {}), { name: 'Error', message: 'sanitizeInline: no document' });
  assert.throws(() => sanitizeAll(makeNode('span'), {}), /no document/);
  assert.equal(typeof globalThis.document, 'undefined', 'the test environment must not have a global document');
});

test('the sanitizer never mutates the source tree', () => {
  const root = makeNode('div', { class: 'c' }, [
    makeNode('a', { href: '/x', onclick: 'hack()' }, [makeText('link')]),
    makeNode('script', {}, [makeText('alert(1)')]),
    makeText('text'),
  ]);
  const before = JSON.stringify(root);
  const first = sanitizeAll(root, { doc: DOC });
  sanitizeAll(root, { doc: DOC });
  assert.equal(JSON.stringify(root), before, 'source attributes and children are untouched');
  assert.equal(sanitizeAll(root, { doc: DOC }), first, 'sanitizing twice yields the same result');
});

test('deep nesting is handled without blowing the stack', () => {
  let deep = makeText('bottom');
  for (let i = 0; i < 30; i++) deep = makeNode('span', {}, [deep]);
  assert.equal(sanitizeInline(deep, { doc: DOC }), `${'<span>'.repeat(30)}bottom${'</span>'.repeat(30)}`);
  assert.equal(sanitizeAll(deep, { doc: DOC }), `${'<span>'.repeat(29)}bottom${'</span>'.repeat(29)}`);

  let pathological = makeText('bottom');
  for (let i = 0; i < 150; i++) pathological = makeNode('div', {}, [pathological]);
  assert.doesNotThrow(() => sanitizeAll(pathological, { doc: DOC }));
});
