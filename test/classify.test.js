import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyBlock, isChromeBlock } from '../src/core/classify.js';

/** Standard context: 16px body, 25.6px line height. */
const CTX = { bodyFontSize: 16, bodyLineHeightPx: 25.6, mode: 'standard' };

test('native headings win in every mode and keep their level', () => {
  for (const mode of ['conservative', 'standard', 'aggressive']) {
    const ctx = { ...CTX, mode };
    assert.deepEqual(classifyBlock({ type: 'para', nativeLevel: 2, fontSize: 16, text: 'Hello' }, ctx), { type: 'heading', level: 2 });
    assert.deepEqual(classifyBlock({ type: 'div', nativeLevel: 1, fontSize: 40, text: 'Title' }, ctx), { type: 'heading', level: 1 });
  }
  assert.deepEqual(classifyBlock({ nativeLevel: 6, text: 'deep' }, CTX), { type: 'heading', level: 6 });
});

test('native levels are rounded and clamped into 1..6', () => {
  assert.equal(classifyBlock({ nativeLevel: 9, text: 'x' }, CTX).level, 6);
  assert.equal(classifyBlock({ nativeLevel: 3.4, text: 'x' }, CTX).level, 3);
  assert.equal(classifyBlock({ nativeLevel: 0, fontSize: 16, text: 'x' }, CTX).type, 'para', 'level 0 is not native');
  assert.equal(classifyBlock({ nativeLevel: -2, fontSize: 16, text: 'x' }, CTX).type, 'para');
  assert.equal(classifyBlock({ nativeLevel: Number.NaN, fontSize: 16, text: 'x' }, CTX).type, 'para');
  assert.equal(classifyBlock({ nativeLevel: '2', fontSize: 16, text: 'x' }, CTX).type, 'para', 'string levels are ignored');
});

test('conservative mode only accepts native headings', () => {
  const ctx = { ...CTX, mode: 'conservative' };
  assert.deepEqual(classifyBlock({ type: 'para', fontSize: 48, fontWeight: 700, allCaps: true, centered: true, text: 'HUGE BOLD' }, ctx), { type: 'para' });
  assert.deepEqual(classifyBlock({ type: 'para', fontSize: 30, text: 'x'.repeat(200) }, ctx), { type: 'para' });
});

test('standard mode: size >= 1.15×body with bold/centered/allCaps and <= 120 chars', () => {
  assert.deepEqual(
    classifyBlock({ type: 'para', fontSize: 20, fontWeight: 700, text: 'a'.repeat(120) }, CTX),
    { type: 'heading', level: 2, bold: true },
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 20, fontWeight: 700, text: 'a'.repeat(121) }, CTX).type,
    'para',
    '121 characters breaks the size+signal rule',
  );
  assert.deepEqual(
    classifyBlock({ type: 'para', fontSize: 18.5, centered: true, text: 'centered' }, CTX),
    { type: 'heading', level: 2, centered: true },
  );
  assert.deepEqual(
    classifyBlock({ type: 'para', fontSize: 18.5, allCaps: true, text: 'CAPS' }, CTX),
    { type: 'heading', level: 2, allCaps: true },
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 18, fontWeight: 400, text: 'plain body text' }, CTX).type,
    'para',
    '18px is only 1.125× body and not bold',
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 20, fontWeight: 400, centered: false, text: 'plain' }, CTX).type,
    'para',
  );
});

test('standard mode: size >= 1.6×body needs no other signal', () => {
  assert.deepEqual(classifyBlock({ type: 'para', fontSize: 26, text: 'plain but big' }, CTX), { type: 'heading', level: 2 });
  assert.equal(classifyBlock({ type: 'para', fontSize: 25.5, text: 'just under' }, CTX).type, 'para');
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 40, text: 'x'.repeat(2000) }, CTX).type,
    'heading',
    'the strong size rule has no length limit',
  );
});

test('standard mode: ALL CAPS short text is a heading', () => {
  assert.deepEqual(classifyBlock({ type: 'para', fontSize: 16, allCaps: true, text: 'A'.repeat(80) }, CTX), { type: 'heading', level: 2, allCaps: true });
  assert.equal(classifyBlock({ type: 'para', fontSize: 16, allCaps: true, text: 'A'.repeat(81) }, CTX).type, 'para');
  assert.equal(classifyBlock({ type: 'para', fontSize: 16, allCaps: true, text: '   ' }, CTX).type, 'para', 'empty text is never a heading');
});

test('empty and whitespace-only text never becomes a heuristic heading', () => {
  for (const text of ['', '   ', '\n\t']) {
    assert.equal(classifyBlock({ type: 'para', fontSize: 48, fontWeight: 700, text }, CTX).type, 'para');
    assert.equal(classifyBlock({ type: 'para', fontSize: 48, allCaps: true, text }, CTX).type, 'para');
  }
  assert.equal(classifyBlock({ type: 'para', fontSize: 48 }, CTX).type, 'para', 'missing text is empty text');
});

test('aggressive mode additionally accepts standalone bold short lines', () => {
  const ctx = { ...CTX, mode: 'aggressive' };
  assert.deepEqual(
    classifyBlock({ type: 'para', fontSize: 16, fontWeight: 700, text: 'Short bold line' }, ctx),
    { type: 'heading', level: 2, bold: true },
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 16, fontWeight: 700, text: 'x'.repeat(81) }, ctx).type,
    'para',
    '81 characters is no longer a short line',
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 16, fontWeight: 400, text: 'Short plain line' }, ctx).type,
    'para',
    'aggressive still requires boldness for the short-line rule',
  );
});

test('aggressive mode accepts bold <br> separated short lines', () => {
  const ctx = { ...CTX, mode: 'aggressive' };
  // Longer than 80 characters, so the standalone bold-line rule cannot fire and
  // only the <br> group rule can promote the block.
  const longText = 'First Second '.repeat(8);
  assert.ok(longText.length > 80);

  assert.equal(
    classifyBlock({ type: 'para', fontSize: 16, bold: true, lines: ['First', 'Second'], text: longText }, ctx).type,
    'heading',
    'every <br> line is bold and short',
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 16, bold: true, lines: ['First', 'x'.repeat(120)], text: longText }, ctx).type,
    'para',
    'one long line disqualifies the group',
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 16, bold: true, lines: ['   ', 'Second'], text: longText }, ctx).type,
    'para',
    'blank lines disqualify the group',
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 16, lines: ['First', 'Second'], text: longText }, ctx).type,
    'para',
    'the group must be bold',
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 16, bold: true, lines: ['only one'], text: longText }, ctx).type,
    'para',
    'a single line is not a <br> separated group',
  );
  assert.equal(
    classifyBlock({ type: 'para', fontSize: 16, fontWeight: 700, lines: ['First', 'Second'], text: 'FirstSecond' }, ctx).type,
    'heading',
    'a short bold text is still caught by the standalone bold-line rule',
  );
});

test('structural block types are preserved and never promoted', () => {
  for (const type of ['li', 'quote', 'code', 'table', 'figure', 'hr']) {
    assert.deepEqual(classifyBlock({ type, fontSize: 16, text: 'x' }, CTX), { type });
    assert.deepEqual(
      classifyBlock({ type, fontSize: 48, fontWeight: 700, text: 'HUGE' }, { ...CTX, mode: 'aggressive' }),
      { type },
      `${type} must not turn into a heading`,
    );
  }
  assert.deepEqual(classifyBlock({ type: 'para', fontSize: 16, text: 'body' }, CTX), { type: 'para' });
  assert.deepEqual(classifyBlock({}, CTX), { type: 'para' });
});

test('already-classified headings are idempotent', () => {
  assert.deepEqual(classifyBlock({ type: 'heading', level: 3, text: 'x' }, CTX), { type: 'heading', level: 3 });
  assert.deepEqual(classifyBlock({ type: 'heading', text: 'x' }, CTX), { type: 'heading', level: 2 });
  assert.deepEqual(classifyBlock({ type: 'heading', level: 99, text: 'x' }, CTX), { type: 'heading', level: 6 });
});

test('classifyBlock tolerates missing or hostile context', () => {
  assert.equal(classifyBlock({ type: 'para', fontSize: 30, fontWeight: 700, text: 'x' }).type, 'heading', 'no context → defaults');
  assert.equal(classifyBlock({ type: 'para', fontSize: 30, fontWeight: 700, text: 'x' }, null).type, 'heading');
  assert.equal(classifyBlock({ type: 'para', fontSize: 30, text: 'x' }, { mode: 'nonsense' }).type, 'heading');
  assert.equal(classifyBlock({ type: 'para', fontSize: 30, text: 'x' }, { bodyFontSize: 0, mode: 'standard' }).type, 'heading');
  assert.equal(classifyBlock({ type: 'para', fontSize: 30, text: 'x' }, { bodyFontSize: Number.NaN }).type, 'heading');
  assert.deepEqual(classifyBlock(null, CTX), { type: 'para' });
  assert.deepEqual(classifyBlock(undefined, CTX), { type: 'para' });
  assert.deepEqual(classifyBlock('nope', CTX), { type: 'para' });
});

test('bold detection accepts an explicit flag, fontWeight >= 600, and rejects light text', () => {
  assert.equal(classifyBlock({ type: 'para', fontSize: 20, bold: true, text: 'x' }, CTX).type, 'heading');
  assert.equal(classifyBlock({ type: 'para', fontSize: 20, fontWeight: 600, text: 'x' }, CTX).type, 'heading');
  assert.equal(classifyBlock({ type: 'para', fontSize: 20, fontWeight: 700, text: 'x' }, CTX).type, 'heading');
  assert.equal(classifyBlock({ type: 'para', fontSize: 20, fontWeight: 500, text: 'x' }, CTX).type, 'para');
  assert.equal(classifyBlock({ type: 'para', fontSize: 20, fontWeight: '700', text: 'x' }, CTX).type, 'para', 'string weights are ignored');
});

test('classifyBlock never mutates its input', () => {
  const block = Object.freeze({
    type: 'para',
    fontSize: 30,
    fontWeight: 700,
    text: 'Frozen heading',
    lines: Object.freeze(['Frozen', 'heading']),
  });
  const before = JSON.stringify(block);
  const out = classifyBlock(block, Object.freeze({ ...CTX, mode: 'aggressive' }));
  assert.equal(JSON.stringify(block), before);
  assert.equal(out.type, 'heading');
  assert.notEqual(out, block);
});

test('isChromeBlock flags navigation, footers, sharing and related noise', () => {
  assert.equal(isChromeBlock({ kind: 'nav', text: 'Home' }), true);
  assert.equal(isChromeBlock({ tagName: 'aside', text: 'x' }), true);
  assert.equal(isChromeBlock({ kind: 'div', className: 'nav-menu', text: 'Home About' }), true);
  assert.equal(isChromeBlock({ kind: 'div', id: 'sidebar' }), true);
  assert.equal(isChromeBlock({ kind: 'div', srcPath: '#main > footer.site-footer > p' }), true);
  assert.equal(isChromeBlock({ kind: 'div', role: 'contentinfo' }), true);
  assert.equal(isChromeBlock({ kind: 'div', role: 'navigation' }), true);
  assert.equal(isChromeBlock({ text: 'Share on Twitter' }), true);
  assert.equal(isChromeBlock({ text: 'Related posts' }), true);
  assert.equal(isChromeBlock({ text: 'Advert' }), true);
  assert.equal(isChromeBlock({ text: 'Skip to content' }), true);
  assert.equal(isChromeBlock({ text: 'Cookie settings' }), true);
});

test('isChromeBlock keeps real content, including text about menus and ads', () => {
  assert.equal(isChromeBlock({ kind: 'p', className: 'article-body', text: 'Hello world' }), false);
  assert.equal(
    isChromeBlock({ kind: 'p', text: 'A normal paragraph about ads and menus in the toolbar of the app.' }),
    false,
    'long prose that merely mentions noise words is not chrome',
  );
  assert.equal(isChromeBlock({ kind: 'p', text: 'Share' }), true);
  assert.equal(isChromeBlock({ kind: 'p', text: 'Sharing economy growth in 2024 was strong.' }), false);
  assert.equal(isChromeBlock({}), false);
  assert.equal(isChromeBlock(null), false);
  assert.equal(isChromeBlock(undefined), false);
  assert.equal(isChromeBlock('nav'), false);
});
