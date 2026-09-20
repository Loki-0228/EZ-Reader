import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segmentForCapitalize, toTitleCase } from '../src/core/title-case.js';

/** The contract example. */
const SAMPLE = 'an iPhone at the DNA lab in the U.S.A. — see https://x.dev/a_b';

/** Apply the documented consumer rule: capitalize word segments that are not skipped. */
function applySegments(text) {
  return segmentForCapitalize(text)
    .map((segment) => {
      if (segment.word !== true || segment.skip === true || segment.text === '') return segment.text;
      const head = String.fromCodePoint(segment.text.codePointAt(0));
      return head.toUpperCase() + segment.text.slice(head.length);
    })
    .join('');
}

test('toTitleCase uppercases only the first character of each word', () => {
  assert.equal(toTitleCase('hello world'), 'Hello World');
  assert.equal(toTitleCase('an iPhone at the DNA lab'), 'An IPhone At The DNA Lab');
  assert.equal(toTitleCase(SAMPLE), 'An IPhone At The DNA Lab In The U.S.A. — See Https://X.Dev/A_B');
  assert.equal(toTitleCase('iPhone'), 'IPhone', 'inner capitals are left alone');
  assert.equal(toTitleCase('DNA'), 'DNA');
  assert.equal(toTitleCase('eBay sells'), 'EBay Sells');
});

test('toTitleCase leaves non-word runs and CJK untouched', () => {
  assert.equal(toTitleCase(''), '');
  assert.equal(toTitleCase('   '), '   ');
  assert.equal(toTitleCase('--- ??? !!!'), '--- ??? !!!');
  assert.equal(toTitleCase('123 456'), '123 456', 'pure digit words are not words');
  assert.equal(toTitleCase('中文测试，继续。'), '中文测试，继续。');
  assert.equal(toTitleCase('a1 b2'), 'A1 B2');
  assert.equal(toTitleCase("don't stop"), "Don't Stop", 'apostrophes stay inside the word');
  assert.equal(toTitleCase('state-of-the-art'), 'State-of-the-art', 'hyphens stay inside the word');
});

test('toTitleCase never throws on degenerate input', () => {
  assert.equal(toTitleCase(null), '');
  assert.equal(toTitleCase(undefined), '');
  assert.equal(toTitleCase(42), '42');
  assert.equal(toTitleCase(true), 'True');
  assert.equal(toTitleCase({}), '[Object Object]');
});

test('segmentForCapitalize reproduces the input byte for byte', () => {
  const samples = [
    SAMPLE,
    '',
    '   ',
    'a-b',
    'x@y.z',
    'visit https://a.b/c?d=e now',
    '中文，测试。',
    'emoji 😀 and text',
    '...!!!???',
    'U.S.A.',
    '123 456',
    'a b c',
    'www.example.com/path.',
    'tab\tseparated\nlines',
  ];
  for (const sample of samples) {
    const joined = segmentForCapitalize(sample).map((segment) => segment.text).join('');
    assert.equal(joined, sample, `segments must rebuild ${JSON.stringify(sample)}`);
  }
});

test('segmentForCapitalize marks punctuation and whitespace as non-words', () => {
  const segments = segmentForCapitalize('a, b');
  assert.deepEqual(segments, [
    { text: 'a', word: true, skip: true },
    { text: ',', word: false },
    { text: ' ', word: false },
    { text: 'b', word: true, skip: true },
  ]);
  const dotted = segmentForCapitalize('U.S.A.');
  assert.deepEqual(dotted.map((s) => [s.text, s.word]), [['U', true], ['.', false], ['S', true], ['.', false], ['A', true], ['.', false]]);
});

test('segmentForCapitalize merges adjacent segments of the same kind', () => {
  const segments = segmentForCapitalize('a   b');
  assert.deepEqual(segments, [
    { text: 'a', word: true, skip: true },
    { text: '   ', word: false },
    { text: 'b', word: true, skip: true },
  ]);
  assert.deepEqual(segmentForCapitalize('a...b').map((s) => s.text), ['a', '...', 'b']);
  assert.deepEqual(segmentForCapitalize('hello world').map((s) => s.text), ['hello', ' ', 'world']);
});

test('segmentForCapitalize skips URLs, e-mails, digits and lone characters', () => {
  const url = segmentForCapitalize('see https://x.dev/a_b now');
  assert.deepEqual(url, [
    { text: 'see', word: true },
    { text: ' ', word: false },
    { text: 'https://x.dev/a_b', word: true, skip: true },
    { text: ' ', word: false },
    { text: 'now', word: true },
  ]);

  const www = segmentForCapitalize('www.example.com');
  assert.deepEqual(www, [{ text: 'www.example.com', word: true, skip: true }]);

  const mail = segmentForCapitalize('mail x@y.z please');
  assert.deepEqual(mail[2], { text: 'x@y.z', word: true, skip: true });

  const digits = segmentForCapitalize('page 42 now');
  assert.deepEqual(digits[2], { text: '42', word: true, skip: true });

  assert.deepEqual(segmentForCapitalize('a'), [{ text: 'a', word: true, skip: true }]);
  assert.deepEqual(segmentForCapitalize('ab'), [{ text: 'ab', word: true }]);
});

test('segmentForCapitalize keeps URL trailing punctuation outside the skip segment', () => {
  const segments = segmentForCapitalize('see https://x.dev/a.');
  assert.deepEqual(segments.map((s) => s.text), ['see', ' ', 'https://x.dev/a', '.']);
  assert.equal(segments[3].word, false);
  assert.equal(segments[3].skip, undefined);
});

test('segmentForCapitalize handles CJK and emoji without splitting them badly', () => {
  const cjk = segmentForCapitalize('中文测试。继续');
  assert.deepEqual(cjk.map((s) => [s.text, s.word]), [['中文测试', true], ['。', false], ['继续', true]]);
  const emoji = segmentForCapitalize('hi 😀 there');
  assert.equal(emoji.map((s) => s.text).join(''), 'hi 😀 there');
  assert.equal(emoji.every((s) => typeof s.text === 'string'), true);
});

test('segmentForCapitalize never throws on degenerate input', () => {
  assert.deepEqual(segmentForCapitalize(''), []);
  assert.deepEqual(segmentForCapitalize(null), []);
  assert.deepEqual(segmentForCapitalize(undefined), []);
  assert.deepEqual(segmentForCapitalize(42), [{ text: '42', word: true, skip: true }]);
});

test('the segment rule produces the documented capitalized reading text', () => {
  assert.equal(applySegments(SAMPLE), 'An IPhone At The DNA Lab In The U.S.A. — See https://x.dev/a_b');
  assert.equal(applySegments('mail x@y.z or visit www.example.com now'), 'Mail x@y.z Or Visit www.example.com Now');
  assert.equal(applySegments('中文测试'), '中文测试');
  assert.equal(applySegments(''), '');
});
