/**
 * Rendering behaviour added after the first core pass:
 *   - `renderDoc` must consume `block.inline` (the sanitized inline tree produced by
 *     dom/scan.js) so `<strong>`/`<a>`/`<code>`/`<br>` survive into the reader view;
 *   - the "capitalize every word's first letter" feature must be a RENDERING effect:
 *     it wraps eligible words in `span[data-ezr-w]` and never rewrites the text, so
 *     copy/paste, find-in-page and screen readers still read the original string.
 *
 * The stub DOM below implements only the surface `render.js` is allowed to use
 * (see CONTRACTS.md section 10), which keeps this file dependency-free.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderDoc, blocksToOutline } from '../src/core/render.js';
import { segmentRanges } from '../src/core/title-case.js';

/* ------------------------------------------------------------------ stub DOM */

function makeElement(doc, tagName) {
  const el = {
    nodeType: 1,
    nodeName: String(tagName).toUpperCase(),
    tagName: String(tagName).toUpperCase(),
    childNodes: [],
    attributes: {},
    parentNode: null,
    get textContent() {
      return this.childNodes.map((child) => child.textContent).join('');
    },
    get children() {
      return this.childNodes.filter((child) => child.nodeType === 1);
    },
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) this.childNodes.splice(i, 1);
      return child;
    },
  };
  return el;
}

function makeText(text) {
  return { nodeType: 3, nodeName: '#text', textContent: String(text), parentNode: null };
}

function makeDoc() {
  const doc = {
    createElement: (tag) => makeElement(doc, tag),
    createTextNode: (text) => makeText(text),
    createDocumentFragment: () => {
      const frag = makeElement(doc, '#fragment');
      frag.nodeType = 11;
      return frag;
    },
  };
  return doc;
}

/** Walk a rendered tree depth-first and collect elements. */
function collect(node, out = []) {
  for (const child of node.childNodes || []) {
    if (child.nodeType === 1) {
      out.push(child);
      collect(child, out);
    }
  }
  return out;
}

function find(node, predicate) {
  return collect(node).find(predicate) || null;
}

function render(blocks, settings = {}) {
  const doc = makeDoc();
  const fragment = renderDoc({ blocks, body: {}, title: 't' }, settings, { doc });
  const article = fragment.childNodes.find((n) => n.nodeType === 1);
  return { doc, fragment, article };
}

const para = (over = {}) => ({
  type: 'para',
  text: 'the quick brown fox jumps over the lazy dog',
  fontSize: 16,
  fontWeight: 400,
  lineHeightPx: 25.6,
  ...over,
});

/* ------------------------------------------------ inline tree is consumed ---- */

test('block.inline is rendered as real elements, not flattened text', () => {
  const { article } = render([
    para({
      text: 'see the strong bit and the link',
      inline: [
        { type: 'text', text: 'see the ' },
        { type: 'element', tag: 'strong', children: [{ type: 'text', text: 'strong bit' }] },
        { type: 'text', text: ' and the ' },
        {
          type: 'element',
          tag: 'a',
          attrs: { href: 'https://example.com/x' },
          children: [{ type: 'text', text: 'link' }],
        },
      ],
    }),
  ]);

  const strong = find(article, (el) => el.nodeName === 'STRONG');
  const anchor = find(article, (el) => el.nodeName === 'A');
  assert.ok(strong, 'strong element must exist');
  assert.equal(strong.textContent, 'strong bit');
  assert.ok(anchor, 'anchor element must exist');
  assert.equal(anchor.getAttribute('href'), 'https://example.com/x');
  assert.equal(article.textContent, 'see the strong bit and the link');
});

test('inline image nodes degrade to an alt chip with no network attribute', () => {
  const { article } = render([
    para({
      inline: [
        { type: 'text', text: 'before ' },
        { type: 'image', alt: 'a chart', src: 'https://evil.test/track.png' },
        { type: 'text', text: ' after' },
      ],
    }),
  ]);

  const chip = find(article, (el) => el.getAttribute('data-ezr-alt') !== null);
  assert.ok(chip, 'alt chip must exist');
  assert.equal(chip.textContent, 'a chart');
  assert.equal(find(article, (el) => el.nodeName === 'IMG'), null, 'no img element may be created');
  // The address may only ever live in a data attribute, never in a loadable one.
  assert.equal(chip.getAttribute('src'), null);
  assert.equal(chip.getAttribute('data-ezr-src'), 'https://evil.test/track.png');
});

test('inline break nodes become <br> elements', () => {
  const { article } = render([
    para({ inline: [{ type: 'text', text: 'line one' }, { type: 'break' }, { type: 'text', text: 'line two' }] }),
  ]);
  assert.ok(find(article, (el) => el.nodeName === 'BR'), 'br must exist');
  assert.equal(article.textContent, 'line oneline two');
});

test('text inside code/kbd/samp/var is never restructured or capitalized', () => {
  const { article } = render(
    [
      para({
        text: 'call fooBar here',
        inline: [
          { type: 'text', text: 'call ' },
          { type: 'element', tag: 'code', children: [{ type: 'text', text: 'fooBar' }] },
          { type: 'text', text: ' here' },
        ],
      }),
    ],
    { capitalizeFirst: true },
  );

  const code = find(article, (el) => el.nodeName === 'CODE');
  assert.ok(code, 'code element must exist');
  assert.equal(code.textContent, 'fooBar', 'identifier must be untouched');
  assert.equal(
    find(code, (el) => el.getAttribute('data-ezr-w') !== null),
    null,
    'no word marker may be created inside code',
  );
});

test('omitting block.inline falls back to the flattened text', () => {
  const { article } = render([para({ text: 'plain fallback text' })]);
  assert.equal(article.textContent, 'plain fallback text');
  assert.equal(collect(article).length, 1, 'only the paragraph itself');
});

/* ------------------------------------------- br-separated lines are kept ---- */

test('block.lines renders as <br>-separated lines when inline is absent', () => {
  const { article } = render([para({ text: 'one two three', lines: ['one', 'two', 'three'] })]);
  const breaks = collect(article).filter((el) => el.nodeName === 'BR');
  assert.equal(breaks.length, 2, 'three lines need two breaks');
  assert.equal(article.textContent, 'onetwothree');
});

test('a single-entry lines array does not introduce breaks', () => {
  const { article } = render([para({ text: 'just one line', lines: ['just one line'] })]);
  assert.equal(collect(article).filter((el) => el.nodeName === 'BR').length, 0);
});

/* ------------------------------------------------- capitalization markers --- */

test('capitalizeFirst wraps eligible words without altering the text', () => {
  const source = 'the quick brown fox';
  const { article } = render([para({ text: source })], { capitalizeFirst: true });

  const markers = collect(article).filter((el) => el.getAttribute('data-ezr-w') !== null);
  assert.deepEqual(
    markers.map((el) => el.textContent),
    ['the', 'quick', 'brown', 'fox'],
  );
  for (const marker of markers) assert.equal(marker.nodeName, 'SPAN');
  assert.equal(article.textContent, source, 'rendered text must be byte-identical to the source');
});

test('capitalizeFirst is off by default and creates no markers', () => {
  const { article } = render([para({ text: 'the quick brown fox' })]);
  assert.equal(collect(article).filter((el) => el.getAttribute('data-ezr-w') !== null).length, 0);
  assert.equal(article.textContent, 'the quick brown fox');
});

test('urls, e-mails, digits and lone characters are never marked', () => {
  const source = 'visit https://example.com/a_b or mail a@b.co in 2024 at x';
  const { article } = render([para({ text: source })], { capitalizeFirst: true });
  const marked = collect(article)
    .filter((el) => el.getAttribute('data-ezr-w') !== null)
    .map((el) => el.textContent);

  assert.ok(!marked.includes('https://example.com/a_b'), 'url must not be marked');
  assert.ok(!marked.includes('a@b.co'), 'e-mail must not be marked');
  assert.ok(!marked.includes('2024'), 'digit run must not be marked');
  assert.ok(marked.includes('visit'), 'ordinary words are still marked');
  assert.equal(article.textContent, source);
});

test('capitalization markers survive a mixed inline tree', () => {
  const { article } = render(
    [
      para({
        text: 'a bold word here',
        inline: [
          { type: 'text', text: 'a ' },
          { type: 'element', tag: 'strong', children: [{ type: 'text', text: 'bold word' }] },
          { type: 'text', text: ' here' },
        ],
      }),
    ],
    { capitalizeFirst: true },
  );

  const strong = find(article, (el) => el.nodeName === 'STRONG');
  const insideStrong = collect(strong).filter((el) => el.getAttribute('data-ezr-w') !== null);
  assert.deepEqual(
    insideStrong.map((el) => el.textContent),
    ['bold', 'word'],
  );
  assert.equal(article.textContent, 'a bold word here');
});

test('headings and list items participate in capitalization', () => {
  const { article } = render(
    [
      { type: 'heading', level: 2, text: 'chapter one start' },
      { type: 'li', text: 'first item detail' },
    ],
    { capitalizeFirst: true },
  );

  const heading = find(article, (el) => el.nodeName === 'H2');
  const item = find(article, (el) => el.nodeName === 'LI');
  assert.equal(heading.getAttribute('data-ezr-level'), '2');
  assert.equal(
    collect(heading).filter((el) => el.getAttribute('data-ezr-w') !== null).length,
    3,
  );
  assert.equal(collect(item).filter((el) => el.getAttribute('data-ezr-w') !== null).length, 3);
});

test('code blocks are never capitalized even when the setting is on', () => {
  const { article } = render([{ type: 'code', text: 'const foo = bar;' }], { capitalizeFirst: true });
  const code = find(article, (el) => el.nodeName === 'CODE');
  assert.equal(code.textContent, 'const foo = bar;');
  assert.equal(collect(article).filter((el) => el.getAttribute('data-ezr-w') !== null).length, 0);
});

/* ------------------------------------------------------------ outline shape -- */

test('blocksToOutline reports heading ids matching data-ezr-id', () => {
  const blocks = [
    para(),
    { type: 'heading', level: 1, text: 'Title' },
    para(),
    { type: 'heading', level: 3, text: 'Section' },
  ];
  const { article } = render(blocks);
  const outline = blocksToOutline({ blocks });

  assert.deepEqual(
    outline.map((entry) => ({ id: entry.id, level: entry.level, text: entry.text })),
    [
      { id: 1, level: 1, text: 'Title' },
      { id: 3, level: 3, text: 'Section' },
    ],
  );

  for (const entry of outline) {
    const target = collect(article).find((el) => el.getAttribute('data-ezr-id') === String(entry.id));
    assert.ok(target, `data-ezr-id=${entry.id} must exist for the outline jump to work`);
  }
});

/* ------------------------------------------------------- segmentRanges units -- */

test('segmentRanges is contiguous and covers the whole input', () => {
  for (const source of ['', 'one', 'a b c', 'x  y', 'visit https://a.b/c now', '中文 with english']) {
    const ranges = segmentRanges(source);
    let cursor = 0;
    for (const range of ranges) {
      assert.equal(range.start, cursor, `gap before ${JSON.stringify(source)}`);
      assert.ok(range.end > range.start);
      cursor = range.end;
    }
    assert.equal(cursor, source.length, `coverage of ${JSON.stringify(source)}`);
  }
});

test('segmentRanges does not merge adjacent words across whitespace', () => {
  const ranges = segmentRanges('alpha beta');
  const words = ranges.filter((r) => r.word && !r.skip).map((r) => 'alpha beta'.slice(r.start, r.end));
  assert.deepEqual(words, ['alpha', 'beta']);
});

test('segmentRanges marks urls and e-mails as skipped', () => {
  const source = 'go to https://example.com/path or a@b.co';
  const skipped = segmentRanges(source)
    .filter((r) => r.skip)
    .map((r) => source.slice(r.start, r.end));
  assert.ok(skipped.includes('https://example.com/path'));
  assert.ok(skipped.includes('a@b.co'));
});
