import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paragraphGapPx } from '../src/core/paragraph-gap.js';
import { DEFAULT_SETTINGS } from '../src/core/constants.js';

/** Default line height: 16px body × 1.6 = 25.6px. */
const LH = DEFAULT_SETTINGS.bodyFontSize * DEFAULT_SETTINGS.lineHeight;

test('default settings produce the documented gap (1.6 × 25.6 + max(2, 1.28))', () => {
  const gap = paragraphGapPx({
    lineHeightPx: LH,
    gapFactor: DEFAULT_SETTINGS.gapFactor,
    gapExtraPx: DEFAULT_SETTINGS.gapExtraPx,
    gapOverridePx: DEFAULT_SETTINGS.gapOverridePx,
  });
  assert.ok(Math.abs(gap - 42.96) < 1e-9, `expected ~42.96, got ${gap}`);
  assert.equal(gap, 1.6 * LH + Math.max(2, LH * 0.05));
  assert.ok(gap > 1.5 * LH);
});

test('the formula is exactly gapFactor * lineHeight + max(gapExtraPx, 0.05 * lineHeight)', () => {
  assert.equal(
    paragraphGapPx({ lineHeightPx: 20, gapFactor: 1.6, gapExtraPx: 5 }),
    1.6 * 20 + 5,
  );
  assert.equal(
    paragraphGapPx({ lineHeightPx: 100, gapFactor: 1.5, gapExtraPx: 0 }),
    1.5 * 100 + 5,
    'the 5% floor wins over a tiny gapExtraPx',
  );
  assert.equal(paragraphGapPx({ lineHeightPx: 40, gapFactor: 2, gapExtraPx: 24 }), 80 + 24);
});

test('the gap is always strictly greater than 1.5 × line height', () => {
  const lineHeights = [0, 0.5, 1, 8, 12, 16, 25.6, 40, 96, 200, 1000];
  const factors = [0, 0.1, 1.15, 1.2, 1.6, 3, 10];
  const extras = [0, 0.5, 2, 24, 500];
  const overrides = [null, 0, 1, 10, 1000, Number.NaN, Number.POSITIVE_INFINITY, '30'];
  for (const lineHeightPx of lineHeights) {
    for (const gapFactor of factors) {
      for (const gapExtraPx of extras) {
        for (const gapOverridePx of overrides) {
          const gap = paragraphGapPx({ lineHeightPx, gapFactor, gapExtraPx, gapOverridePx });
          assert.ok(Number.isFinite(gap), `non-finite gap for ${lineHeightPx}/${gapFactor}/${gapExtraPx}/${gapOverridePx}`);
          assert.ok(
            gap > 1.5 * lineHeightPx,
            `gap ${gap} must exceed ${1.5 * lineHeightPx} (lh=${lineHeightPx}, factor=${gapFactor}, extra=${gapExtraPx}, override=${gapOverridePx})`,
          );
        }
      }
    }
  }
});

test('the gap is monotonically non-decreasing in lineHeightPx', () => {
  const configs = [
    {},
    { gapFactor: 1.6, gapExtraPx: 2 },
    { gapFactor: 1.15, gapExtraPx: 0 },
    { gapFactor: 0, gapExtraPx: 0 },
    { gapFactor: 0, gapExtraPx: 12 },
    { gapFactor: 3, gapExtraPx: 24 },
    { gapFactor: 1.6, gapExtraPx: 2, gapOverridePx: 30 },
    { gapFactor: 1.6, gapExtraPx: 2, gapOverridePx: 0 },
    { gapFactor: -5, gapExtraPx: -5 },
    { gapFactor: 1.6, gapExtraPx: 2, gapOverridePx: 5 },
  ];
  for (const config of configs) {
    let previous = Number.NEGATIVE_INFINITY;
    for (let lineHeightPx = 0; lineHeightPx <= 120; lineHeightPx += 0.5) {
      const gap = paragraphGapPx({ ...config, lineHeightPx });
      assert.ok(gap >= previous, `not monotone at lh=${lineHeightPx} with ${JSON.stringify(config)}: ${gap} < ${previous}`);
      previous = gap;
    }
  }
});

test('a finite gapOverridePx is honoured but still floored above 1.5L', () => {
  assert.equal(paragraphGapPx({ lineHeightPx: 20, gapOverridePx: 60 }), 60);
  const zeroOverride = paragraphGapPx({ lineHeightPx: 20, gapOverridePx: 0 });
  assert.ok(zeroOverride > 1.5 * 20, `an override below the floor must be raised, got ${zeroOverride}`);
  assert.ok(zeroOverride < 1.5 * 20 + 0.001, 'and only raised by a numerically tiny amount');
  const floored = paragraphGapPx({ lineHeightPx: 100, gapOverridePx: 10 });
  assert.ok(floored >= 150, `override below the floor must be raised, got ${floored}`);
  assert.ok(floored > 150);
});

test('non-finite gapOverridePx falls back to the formula', () => {
  const expected = paragraphGapPx({ lineHeightPx: LH, gapFactor: 1.6, gapExtraPx: 2 });
  for (const gapOverridePx of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '40', {}]) {
    assert.equal(paragraphGapPx({ lineHeightPx: LH, gapFactor: 1.6, gapExtraPx: 2, gapOverridePx }), expected);
  }
});

test('degenerate input never throws and never escapes the invariants', () => {
  assert.ok(paragraphGapPx() > 0);
  assert.ok(paragraphGapPx({}) > 0);
  assert.ok(paragraphGapPx(null) > 0);
  assert.ok(paragraphGapPx(undefined) > 0);
  assert.ok(paragraphGapPx('nonsense') > 0);
  assert.ok(paragraphGapPx(42) > 0);

  const fallback = paragraphGapPx({ lineHeightPx: LH, gapFactor: 1.6, gapExtraPx: 2 });
  assert.equal(paragraphGapPx({ lineHeightPx: Number.NaN }), fallback);
  assert.equal(paragraphGapPx({ lineHeightPx: Number.POSITIVE_INFINITY }), fallback);
  assert.equal(paragraphGapPx({ lineHeightPx: '25.6' }), fallback);

  // Negative line heights collapse to 0 instead of flipping the sign.
  assert.equal(paragraphGapPx({ lineHeightPx: -20, gapFactor: 1.6, gapExtraPx: 2 }), 2);
  assert.ok(paragraphGapPx({ lineHeightPx: -20 }) > 0);

  // Negative factors are raised to 0 so the result stays monotone and positive.
  assert.equal(paragraphGapPx({ lineHeightPx: 10, gapFactor: -3, gapExtraPx: 20 }), 20);
  assert.equal(paragraphGapPx({ lineHeightPx: 10, gapFactor: 1.6, gapExtraPx: -3 }), 1.6 * 10 + 0.5);
  assert.equal(paragraphGapPx({ lineHeightPx: 0, gapFactor: 0, gapExtraPx: 0 }), 1e-9, 'still strictly positive at zero line height');
  assert.ok(paragraphGapPx({ lineHeightPx: 0, gapFactor: 0, gapExtraPx: 0 }) > 0);
});

test('the input object is never mutated', () => {
  const options = Object.freeze({
    lineHeightPx: 25.6,
    gapFactor: 1.6,
    gapExtraPx: 2,
    gapOverridePx: null,
  });
  const before = JSON.stringify(options);
  paragraphGapPx(options);
  assert.equal(JSON.stringify(options), before);
  assert.deepEqual(options, { lineHeightPx: 25.6, gapFactor: 1.6, gapExtraPx: 2, gapOverridePx: null });
});
