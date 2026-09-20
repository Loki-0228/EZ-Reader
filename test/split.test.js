import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isContinuationLine, splitAll, splitBlock } from '../src/core/split.js';

test('line breaks within an actual point stay in the same item', () => {
  const item = { type: 'li', text: 'Point.\nExplanation.', lines: ['Point.', 'Explanation.'] };
  assert.deepEqual(splitBlock(item), [item]);
});

test('split paragraphs preserve inline emphasis without repeating the entire source', () => {
  const parts = splitBlock({ type: 'para', lines: ['First.', 'Second.'], inline: [
    { type: 'element', tag: 'strong', children: [{ type: 'text', text: 'First.' }, { type: 'break' }, { type: 'text', text: 'Second.' }] },
  ] });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, 'para');
  assert.equal(parts[0].inline[0].children[0].text, 'First.');
  assert.equal(parts[1].inline[0].children[0].text, 'Second.');
});

test('isContinuationLine: previous line ends with a letter, hyphen or comma', () => {
  assert.equal(isContinuationLine('hello', 'world'), true);
  assert.equal(isContinuationLine('inter-', 'national'), true);
  assert.equal(isContinuationLine('hello,', 'world'), true);
  assert.equal(isContinuationLine('中文', 'abc'), true, 'letters are Unicode aware');
});

test('isContinuationLine: the next line must start lowercase', () => {
  assert.equal(isContinuationLine('hello', 'World'), false);
  assert.equal(isContinuationLine('hello', '世界'), false, 'CJK has no lowercase form');
  assert.equal(isContinuationLine('hello', ''), false);
  assert.equal(isContinuationLine('hello', '  world'), true, 'leading whitespace is ignored');
  assert.equal(isContinuationLine('hello ', 'world'), true, 'trailing whitespace is ignored');
});

test('isContinuationLine: other endings do not continue a line', () => {
  assert.equal(isContinuationLine('hello.', 'world'), false, 'a full stop ends the sentence');
  assert.equal(isContinuationLine('hello:', 'world'), false);
  assert.equal(isContinuationLine('hello?', 'world'), false);
  assert.equal(isContinuationLine('123', 'world'), false);
  assert.equal(isContinuationLine('', 'world'), false);
  assert.equal(isContinuationLine('   ', 'world'), false);
});

test('isContinuationLine tolerates non-string input', () => {
  assert.equal(isContinuationLine(null, 'world'), false);
  assert.equal(isContinuationLine('hello', null), false);
  assert.equal(isContinuationLine(undefined, undefined), false);
  assert.equal(isContinuationLine(42, 'world'), false);
  assert.equal(isContinuationLine('hello', 42), false);
  assert.equal(isContinuationLine({}, []), false);
});

test('splitBlock returns the very same block when there is nothing to split', () => {
  const noLines = { type: 'para', text: 'one line', fontSize: 16 };
  assert.equal(splitBlock(noLines)[0], noLines);
  assert.equal(splitBlock(noLines).length, 1);

  const single = { type: 'para', text: 'one line', lines: ['one line'] };
  assert.equal(splitBlock(single)[0], single);

  const empty = { type: 'para', text: '', lines: [] };
  assert.equal(splitBlock(empty)[0], empty);

  const blank = { type: 'para', text: '  ', lines: ['  ', '\t'] };
  assert.equal(splitBlock(blank)[0], blank, 'nothing meaningful to split');

  const notArray = { type: 'para', text: 'x', lines: 'nope' };
  assert.equal(splitBlock(notArray)[0], notArray);

  assert.deepEqual(splitBlock(null), [null]);
  assert.deepEqual(splitBlock(undefined), [undefined]);
  assert.deepEqual(splitBlock('nope'), ['nope']);
  assert.deepEqual(splitBlock(42), [42]);
});

test('splitBlock turns every non-empty line into its own block', () => {
  const block = {
    type: 'para',
    text: 'First line\nSecond line\nThird line',
    lines: ['First line', 'Second line', 'Third line'],
    fontSize: 18,
    fontWeight: 700,
    lineHeightPx: 28.8,
    top: 120,
    kind: 'div',
  };
  const out = splitBlock(block);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((b) => b.text), ['First line', 'Second line', 'Third line']);
  assert.deepEqual(out.map((b) => b.html), ['First line', 'Second line', 'Third line']);
  for (const part of out) {
    assert.equal(part.type, 'para');
    assert.equal(part.fontSize, 18);
    assert.equal(part.fontWeight, 700);
    assert.equal(part.lineHeightPx, 28.8);
    assert.equal(part.top, 120);
    assert.equal(part.kind, 'div');
    assert.equal(Object.hasOwn(part, 'lines'), false, 'the stale lines array is dropped');
  }
  assert.notEqual(out[0], block);
  assert.notEqual(out[1], out[0]);
});

test('splitBlock escapes each line into its html field', () => {
  const out = splitBlock({ type: 'para', text: 'x', lines: ['<b>bold</b>', 'a & b', 'say "hi"'] });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((b) => b.html), ['&lt;b&gt;bold&lt;/b&gt;', 'a &amp; b', 'say &quot;hi&quot;']);
  assert.deepEqual(out.map((b) => b.text), ['<b>bold</b>', 'a & b', 'say "hi"']);
});

test('splitBlock drops blank lines but keeps the text verbatim', () => {
  const out = splitBlock({ type: 'para', text: 'a b', lines: ['a', '   ', '', 'b'] });
  assert.deepEqual(out.map((b) => b.text), ['a', 'b']);
  const padded = splitBlock({ type: 'para', text: 'x', lines: ['  spaced  ', 'second'] });
  assert.equal(padded[0].text, '  spaced  ', 'lines are kept byte identical');
  assert.equal(padded[0].html, '  spaced  ');
});

test('splitBlock never mutates the source block', () => {
  const block = Object.freeze({
    type: 'para',
    text: 'a\nb',
    lines: Object.freeze(['a', 'b']),
    fontSize: 16,
  });
  const out = splitBlock(block);
  assert.equal(out.length, 2);
  assert.equal(block.text, 'a\nb');
  assert.deepEqual([...block.lines], ['a', 'b']);
  assert.equal(Object.hasOwn(block, 'html'), false);
  assert.notEqual(out[0], block);
});

test('splitAll flattens blocks in order', () => {
  const first = { type: 'para', text: 'a\nb', lines: ['a', 'b'] };
  const second = { type: 'para', text: 'single' };
  const third = { type: 'li', text: 'x\ny\nz', lines: ['x', 'y', 'z'] };
  const out = splitAll([first, second, third]);
  assert.deepEqual(out.map((b) => b.text), ['a', 'b', 'single', 'x\ny\nz']);
  assert.equal(out[2], second, 'unsplittable blocks pass through by reference');
  assert.equal(out[3], third, 'one list point remains one point');
  assert.equal(out.length, 4);
});

test('splitAll handles empty and adversarial input', () => {
  assert.deepEqual(splitAll([]), []);
  assert.deepEqual(splitAll(null), []);
  assert.deepEqual(splitAll(undefined), []);
  assert.deepEqual(splitAll('nope'), []);
  assert.deepEqual(splitAll([null, { type: 'para', text: 'x' }]).length, 2);
});
