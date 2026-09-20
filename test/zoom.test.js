import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeZoom } from '../src/ui/zoom.js';

test('fit width enlarges the design column to fill a wide window', () => {
  assert.equal(computeZoom({ mode: 'fit-width', containerWidth: 1265, contentWidth: 704 }), 1265 / 704);
  assert.equal(computeZoom({ mode: 'fit-width', containerWidth: 736, contentWidth: 704, padding: 32 }), 1);
  assert.equal(computeZoom({ mode: 'fit-width', containerWidth: 3000, contentWidth: 704 }), 2.5);
});

test('fit page retains its separate shrink-only behavior', () => {
  assert.equal(computeZoom({ mode: 'fit-page', containerWidth: 1265, contentWidth: 704 }), 1);
  assert.equal(computeZoom({ mode: 'fit-page', containerWidth: 704, contentWidth: 704 }), 1);
});

test('automatic zoom shrinks the design column to available width', () => {
  assert.equal(computeZoom({ containerWidth: 528, contentWidth: 704 }), 0.75);
  assert.equal(computeZoom({ containerWidth: 560, contentWidth: 704, padding: 32 }), 0.75);
  assert.equal(computeZoom({ mode: 'fit-page', containerWidth: 528, contentWidth: 704 }), 0.75);
  assert.equal(computeZoom({ containerWidth: 300, contentWidth: 704 }), 0.6);
});

test('manual zoom still supports enlargement and respects its limits', () => {
  assert.equal(computeZoom({ mode: 'manual', manual: 1.35 }), 1.35);
  assert.equal(computeZoom({ mode: 'manual', manual: 10 }), 2.5);
  assert.equal(computeZoom({ mode: 'manual', manual: 0.1 }), 0.6);
});

test('unavailable layout measurements keep a safe neutral scale', () => {
  for (const contentWidth of [0, NaN, Infinity, undefined]) {
    assert.equal(computeZoom({ containerWidth: 1280, contentWidth }), 1);
  }
  assert.equal(computeZoom({ containerWidth: 0, contentWidth: 704 }), 1);
});
