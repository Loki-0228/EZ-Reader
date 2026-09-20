import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignHeadingLevels, clusterFontSizes } from '../src/core/heading-levels.js';

test('clusterFontSizes returns [{fontSize, count}] ordered by descending size', () => {
  assert.deepEqual(clusterFontSizes([16, 30, 21]), [
    { fontSize: 30, count: 1 },
    { fontSize: 21, count: 1 },
    { fontSize: 16, count: 1 },
  ]);
  assert.deepEqual(clusterFontSizes([16, 16, 16, 24]), [
    { fontSize: 24, count: 1 },
    { fontSize: 16, count: 3 },
  ]);
});

test('clusterFontSizes merges sizes within the 0.5px default tolerance', () => {
  assert.deepEqual(clusterFontSizes([16.0, 16.2, 15.9]), [{ fontSize: 16.2, count: 3 }]);
  assert.deepEqual(clusterFontSizes([16.0, 16.5]), [{ fontSize: 16.5, count: 2 }], 'exactly 0.5 apart still merges');
  assert.deepEqual(clusterFontSizes([16.0, 16.6]), [
    { fontSize: 16.6, count: 1 },
    { fontSize: 16.0, count: 1 },
  ], '0.6 apart splits');
});

test('clustering compares against the cluster representative, not the previous value', () => {
  assert.deepEqual(clusterFontSizes([16, 16.6, 17.2]), [
    { fontSize: 17.2, count: 1 },
    { fontSize: 16.6, count: 1 },
    { fontSize: 16, count: 1 },
  ], 'chained growth must not collapse into one cluster');
});

test('clusterFontSizes accepts a custom tolerance', () => {
  assert.deepEqual(clusterFontSizes([10, 12], 2), [{ fontSize: 12, count: 2 }]);
  assert.deepEqual(clusterFontSizes([10, 12], 1.9), [
    { fontSize: 12, count: 1 },
    { fontSize: 10, count: 1 },
  ]);
  assert.deepEqual(clusterFontSizes([10, 10, 11], 0), [
    { fontSize: 11, count: 1 },
    { fontSize: 10, count: 2 },
  ]);
  assert.deepEqual(clusterFontSizes([10, 11], 0), [
    { fontSize: 11, count: 1 },
    { fontSize: 10, count: 1 },
  ]);
});

test('clusterFontSizes survives adversarial input', () => {
  assert.deepEqual(clusterFontSizes([]), []);
  assert.deepEqual(clusterFontSizes(null), []);
  assert.deepEqual(clusterFontSizes(undefined), []);
  assert.deepEqual(clusterFontSizes('16,20'), []);
  assert.deepEqual(clusterFontSizes(42), []);
  assert.deepEqual(clusterFontSizes([Number.NaN, Number.POSITIVE_INFINITY, -Infinity]), []);
  assert.deepEqual(clusterFontSizes([16, Number.NaN, 'x', null, undefined, 20]), [
    { fontSize: 20, count: 1 },
    { fontSize: 16, count: 1 },
  ]);
  assert.deepEqual(clusterFontSizes([-4, -4.2]), [{ fontSize: -4, count: 2 }], 'negative sizes still cluster');
  assert.deepEqual(clusterFontSizes([10, 10.4], Number.NaN), [{ fontSize: 10.4, count: 2 }], 'NaN tolerance → default');
  assert.deepEqual(clusterFontSizes([10, 11], -1), [
    { fontSize: 11, count: 1 },
    { fontSize: 10, count: 1 },
  ], 'negative tolerance behaves like 0');
});

test('assignHeadingLevels maps clusters to levels in document order', () => {
  const blocks = [
    { type: 'heading', fontSize: 30, text: 'A' },
    { type: 'para', fontSize: 16, text: 'b' },
    { type: 'heading', fontSize: 20, text: 'C' },
    { type: 'heading', fontSize: 20.2, text: 'D' },
  ];
  const out = assignHeadingLevels(blocks);
  assert.equal(out[0].level, 1);
  assert.equal(out[2].level, 2);
  assert.equal(out[3].level, 2, 'same cluster → same level');
  assert.ok(!('level' in out[1]), 'non-heading blocks never gain a level');
  assert.equal(out.length, blocks.length);
});

test('assignHeadingLevels clamps the seventh cluster to level 6', () => {
  const sizes = [70, 60, 50, 40, 30, 20, 10];
  const blocks = sizes.map((fontSize) => ({ type: 'heading', fontSize }));
  const out = assignHeadingLevels(blocks);
  assert.deepEqual(out.map((b) => b.level), [1, 2, 3, 4, 5, 6, 6]);
});

test('a single cluster collapses every heading to level 2', () => {
  const blocks = [
    { type: 'heading', fontSize: 20, text: 'one' },
    { type: 'heading', fontSize: 20.3, text: 'two' },
    { type: 'heading', fontSize: 19.8, text: 'three' },
  ];
  const out = assignHeadingLevels(blocks);
  assert.deepEqual(out.map((b) => b.level), [2, 2, 2]);
});

test('a lone heading also collapses to level 2', () => {
  const out = assignHeadingLevels([{ type: 'heading', fontSize: 48, text: 'Title' }]);
  assert.equal(out[0].level, 2);
});

test('nativeLevel only breaks ties inside a cluster and never overrides size', () => {
  const blocks = [
    { type: 'heading', fontSize: 30, nativeLevel: 4, text: 'small native, big font' },
    { type: 'heading', fontSize: 18, nativeLevel: 1, text: 'h1 but smaller font' },
  ];
  const out = assignHeadingLevels(blocks);
  assert.deepEqual(out.map((b) => b.level), [1, 2], 'font size wins over nativeLevel');

  const tied = [
    { type: 'heading', fontSize: 22, nativeLevel: 3, text: 'x' },
    { type: 'heading', fontSize: 22, nativeLevel: 1, text: 'y' },
  ];
  assert.deepEqual(assignHeadingLevels(tied).map((b) => b.level), [2, 2]);
});

test('assignHeadingLevels returns new objects and mutates nothing', () => {
  const blocks = [
    Object.freeze({ type: 'heading', fontSize: 30, text: 'A', extra: 'kept' }),
    Object.freeze({ type: 'para', fontSize: 16, text: 'b', top: 120 }),
    Object.freeze({ type: 'heading', fontSize: 18, level: 5, text: 'C' }),
  ];
  const frozen = Object.freeze(blocks);
  const out = assignHeadingLevels(frozen);

  assert.notEqual(out, frozen);
  assert.notEqual(out[0], frozen[0]);
  assert.equal(out[0].level, 1);
  assert.equal(out[2].level, 2, 'an existing level is recomputed');
  assert.equal(out[0].extra, 'kept', 'unknown fields are preserved');
  assert.equal(out[1].top, 120);
  assert.ok(!('level' in frozen[0]), 'the input block keeps no level');
  assert.ok(!('level' in frozen[2]) || frozen[2].level === 5, 'the input block is unchanged');
  assert.equal(frozen[2].level, 5);
});

test('assignHeadingLevels handles empty and adversarial input', () => {
  assert.deepEqual(assignHeadingLevels([]), []);
  assert.deepEqual(assignHeadingLevels(null), []);
  assert.deepEqual(assignHeadingLevels(undefined), []);
  assert.deepEqual(assignHeadingLevels('nope'), []);
  assert.deepEqual(assignHeadingLevels([null, 42, 'x']), [null, 42, 'x']);
  assert.deepEqual(assignHeadingLevels([{ type: 'para', fontSize: 30 }]).map((b) => 'level' in b), [false]);

  const noSize = assignHeadingLevels([
    { type: 'heading', text: 'no font size' },
    { type: 'heading', fontSize: 30, text: 'big' },
  ]);
  assert.deepEqual(noSize.map((b) => b.level), [2, 1], 'a missing fontSize is treated as the smallest size');
});
