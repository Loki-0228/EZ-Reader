/**
 * Coverage for `sanitize.inlineNodes` — the DOM-free data form of the sanitized inline
 * tree that `core/render.js` consumes.
 *
 * Two implementations of one policy (an HTML string and a node tree) would normally
 * drift; these tests pin the node tree to the same rules the HTML serializer is
 * already tested against, and a dedicated parity test compares both outputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inlineNodes, sanitizeAll } from '../src/core/sanitize.js';

/** Stub element: only the DOM surface CONTRACTS.md section 10 allows. */
function makeNode(nodeName, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    nodeName: nodeName.toUpperCase(),
    childNodes: children,
    attributes: { ...attrs },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    get textContent() {
      return this.childNodes.map((child) => child.textContent).join('');
    },
  };
  return node;
}

function makeText(text) {
  return { nodeType: 3, nodeName: '#text', childNodes: [], textContent: String(text) };
}

const DOC = { baseURI: 'https://example.com/post/1' };

/** Flatten an inline tree to the plain text it would render as. */
function textOfNodes(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.text;
    else if (node.type === 'image') out += node.alt;
    else if (node.type === 'element') out += textOfNodes(node.children || []);
  }
  return out;
}

test('text nodes become text nodes and keep their content verbatim', () => {
  const nodes = inlineNodes(makeNode('p', {}, [makeText('a < b & c')]), { doc: DOC });
  assert.deepEqual(nodes, [{ type: 'text', text: 'a < b & c' }]);
});

test('empty text runs are dropped rather than emitted as empty nodes', () => {
  const nodes = inlineNodes(makeNode('p', {}, [makeText('')]), { doc: DOC });
  assert.deepEqual(nodes, []);
});

test('whitelisted inline elements become element nodes', () => {
  const nodes = inlineNodes(
    makeNode('p', {}, [makeNode('strong', {}, [makeText('bold')]), makeNode('em', {}, [makeText(' it')])]),
    { doc: DOC },
  );
  assert.deepEqual(nodes, [
    { type: 'element', tag: 'strong', attrs: {}, children: [{ type: 'text', text: 'bold' }] },
    { type: 'element', tag: 'em', attrs: {}, children: [{ type: 'text', text: ' it' }] },
  ]);
});

test('anchors keep a resolved href and title', () => {
  const nodes = inlineNodes(
    makeNode('p', {}, [makeNode('a', { href: '/x/y', title: 'tip' }, [makeText('link')])]),
    { doc: DOC },
  );
  assert.equal(nodes[0].tag, 'a');
  assert.equal(nodes[0].attrs.href, 'https://example.com/x/y');
  assert.equal(nodes[0].attrs.title, 'tip');
});

test('javascript: anchors degrade to a span but keep their text', () => {
  const nodes = inlineNodes(
    makeNode('p', {}, [makeNode('a', { href: 'java\nscript:alert(1)' }, [makeText('click')])]),
    { doc: DOC },
  );
  assert.equal(nodes[0].tag, 'a');
  assert.deepEqual(nodes[0].attrs, {}, 'no href may survive');
  assert.equal(textOfNodes(nodes), 'click', 'text must be preserved');
});

test('unknown elements are unwrapped without losing their children', () => {
  const nodes = inlineNodes(
    makeNode('p', {}, [
      makeText('a '),
      makeNode('section', {}, [makeText('b'), makeNode('span', {}, [makeText('c')])]),
      makeText(' d'),
    ]),
    { doc: DOC },
  );
  assert.equal(textOfNodes(nodes), 'a bc d');
  assert.equal(nodes.filter((n) => n.type === 'element' && n.tag === 'section').length, 0, 'section must not survive');
});

test('script, style, iframe and svg vanish with their content', () => {
  for (const tag of ['script', 'style', 'iframe', 'svg']) {
    const nodes = inlineNodes(
      makeNode('p', {}, [makeText('keep'), makeNode(tag, {}, [makeText('DROP')]), makeText(' keep')]),
      { doc: DOC },
    );
    assert.equal(textOfNodes(nodes), 'keep keep', `${tag} content must be gone`);
  }
});

test('br becomes a break node', () => {
  const nodes = inlineNodes(makeNode('p', {}, [makeText('one'), makeNode('br'), makeText('two')]), { doc: DOC });
  assert.deepEqual(nodes, [
    { type: 'text', text: 'one' },
    { type: 'break' },
    { type: 'text', text: 'two' },
  ]);
});

test('images become image nodes carrying only inert data', () => {
  const nodes = inlineNodes(makeNode('p', {}, [makeNode('img', { src: '/i/x.png', alt: 'a chart' })]), { doc: DOC });
  assert.deepEqual(nodes, [{ type: 'image', alt: 'a chart', src: 'https://example.com/i/x.png' }]);

  const noAlt = inlineNodes(makeNode('p', {}, [makeNode('img', { src: '/i/x.png' })]), { doc: DOC });
  assert.deepEqual(noAlt, [], 'an image without alt carries no content');

  const evil = inlineNodes(makeNode('p', {}, [makeNode('img', { src: 'data:text/html,x', alt: 'x' })]), { doc: DOC });
  assert.deepEqual(evil, [{ type: 'image', alt: 'x' }], 'dangerous src must be dropped');
});

test('code-like elements keep their tag so identifiers stay verbatim', () => {
  const nodes = inlineNodes(makeNode('p', {}, [makeNode('code', {}, [makeText('fooBar()')])]), { doc: DOC });
  assert.equal(nodes[0].tag, 'code');
});

test('childNodes is never assumed to exist', () => {
  const bare = { nodeType: 1, nodeName: 'P' };
  assert.deepEqual(inlineNodes(bare, { doc: DOC }), []);
});

test('null and non-node inputs yield an empty tree instead of throwing', () => {
  assert.deepEqual(inlineNodes(null, { doc: DOC }), []);
  assert.deepEqual(inlineNodes(undefined, { doc: DOC }), []);
  assert.deepEqual(inlineNodes(42, { doc: DOC }), []);
  assert.deepEqual(inlineNodes({ nodeType: 8 }, { doc: DOC }), []);
});

test('a document or fragment root walks its children', () => {
  const fragment = { nodeType: 11, childNodes: [makeText('x'), makeNode('strong', {}, [makeText('y')])] };
  const nodes = inlineNodes(fragment, { doc: DOC });
  assert.equal(textOfNodes(nodes), 'xy');
});

test('the node tree and the HTML string agree on visible text', () => {
  const tree = makeNode('p', {}, [
    makeText('alpha '),
    makeNode('strong', {}, [makeText('beta')]),
    makeNode('br'),
    makeNode('img', { src: 'x.png', alt: 'chart' }),
    makeNode('script', {}, [makeText('DROP')]),
    makeNameNode(),
  ]);

  const nodes = inlineNodes(tree, { doc: DOC });
  assert.equal(textOfNodes(nodes), 'alpha betachart');
  const html = sanitizeAll(tree, { doc: DOC });
  assert.ok(!html.includes('DROP'), 'serializer must also drop script content');
  assert.ok(html.includes('chart'), 'serializer must also keep the alt text');
});

/** An element with a name that is neither whitelisted nor dropped. */
function makeNameNode() {
  return makeNode('foo-bar', {}, [makeText('')]);
}
