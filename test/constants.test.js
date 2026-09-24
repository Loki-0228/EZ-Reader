import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_TYPES,
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  HEADING_FONT_SIZES,
  MAX_BLOCKS,
  MAX_HEADING_LEVEL,
  MIN_HEADING_LEVEL,
  NEGATIVE_HINT_RE,
  POSITIVE_HINT_RE,
  SETTING_LIMITS,
  clamp,
  escapeHtml,
} from '../src/core/constants.js';

test('BLOCK_TYPES is a frozen list of the eight IR block types', () => {
  assert.ok(Object.isFrozen(BLOCK_TYPES));
  assert.deepEqual([...BLOCK_TYPES], ['heading', 'para', 'li', 'quote', 'code', 'table', 'figure', 'hr']);
  assert.equal(new Set(BLOCK_TYPES).size, BLOCK_TYPES.length);
});

test('level and block-count bounds match the contract', () => {
  assert.equal(MIN_HEADING_LEVEL, 1);
  assert.equal(MAX_HEADING_LEVEL, 6);
  assert.equal(MAX_BLOCKS, 20000);
});

test('FONT_FAMILIES is frozen, unique and free of remote references', () => {
  assert.ok(Object.isFrozen(FONT_FAMILIES));
  assert.equal(FONT_FAMILIES.length, 6);
  const ids = new Set();
  for (const family of FONT_FAMILIES) {
    assert.ok(Object.isFrozen(family));
    assert.equal(typeof family.id, 'string');
    assert.ok(family.id.length > 0);
    assert.equal(typeof family.label, 'string');
    assert.ok(family.label.length > 0);
    assert.equal(typeof family.stack, 'string');
    assert.ok(family.stack.length > 0);
    assert.ok(!/https?:|url\s*\(/i.test(family.stack), `remote reference in ${family.id}`);
    assert.ok(/(serif|sans-serif|monospace)$/.test(family.stack), `missing generic family in ${family.id}`);
    ids.add(family.id);
  }
  assert.equal(ids.size, FONT_FAMILIES.length);
  assert.ok(ids.has('serif-georgia'));
});

test('HEADING_FONT_SIZES is frozen, descending and complete', () => {
  assert.ok(Object.isFrozen(HEADING_FONT_SIZES));
  assert.equal(HEADING_FONT_SIZES.length, MAX_HEADING_LEVEL);
  for (let i = 0; i < HEADING_FONT_SIZES.length; i++) {
    assert.ok(HEADING_FONT_SIZES[i] > 0);
    if (i > 0) assert.ok(HEADING_FONT_SIZES[i] < HEADING_FONT_SIZES[i - 1]);
  }
  assert.deepEqual([...HEADING_FONT_SIZES], [30, 25, 21, 18, 17, 16]);
});

test('DEFAULT_SETTINGS is frozen and exactly as specified', () => {
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.deepEqual(DEFAULT_SETTINGS, {
    fontId: 'serif-georgia',
    bodyFontSize: 16,
    lineHeight: 1.6,
    gapFactor: 1.6,
    gapExtraPx: 2,
    gapOverridePx: null,
    measure: 44,
    headingMode: 'standard',
    splitLines: true,
    capitalizeFirst: false,
    capitalizeLocales: '',
    zoomMode: 'fit-width',
    zoom: 1,
    theme: 'light',
    showOutline: false,
    toolbarDock: 'top',
    rememberPerSite: true,
    restorePosition: true,
  });
  assert.equal(DEFAULT_SETTINGS.gapOverridePx, null);
  assert.equal(DEFAULT_SETTINGS.bodyFontSize * DEFAULT_SETTINGS.lineHeight, 25.6);
});

test('every numeric default sits inside SETTING_LIMITS', () => {
  assert.ok(Object.isFrozen(SETTING_LIMITS));
  assert.deepEqual(Object.keys(SETTING_LIMITS).sort(), [
    'bodyFontSize', 'gapExtraPx', 'gapFactor', 'lineHeight', 'measure', 'zoom',
  ]);
  for (const [key, range] of Object.entries(SETTING_LIMITS)) {
    assert.ok(Object.isFrozen(range));
    assert.ok(range.min <= range.max, `${key} has inverted bounds`);
    const value = DEFAULT_SETTINGS[key];
    assert.equal(typeof value, 'number');
    assert.ok(value >= range.min && value <= range.max, `${key} default outside its limits`);
  }
  assert.deepEqual(SETTING_LIMITS.bodyFontSize, { min: 14, max: 24 });
  assert.deepEqual(SETTING_LIMITS.zoom, { min: 0.6, max: 2.5 });
});

test('hint regexes match noise and content hints respectively', () => {
  for (const noise of ['nav', 'sidebar', 'comment-list', 'Advert', 'cookie-banner', 'skip-link', 'main-footer', 'SOCIAL', 'ads', 'promo-box']) {
    assert.ok(NEGATIVE_HINT_RE.test(noise), `expected noise match: ${noise}`);
  }
  for (const keep of ['article', 'post-content', 'markdown-body', 'main', 'entry-title', 'STORY']) {
    assert.ok(POSITIVE_HINT_RE.test(keep), `expected content match: ${keep}`);
  }
  assert.equal(NEGATIVE_HINT_RE.test('hello world'), false);
  assert.equal(NEGATIVE_HINT_RE.test('navigation'), false, 'nav inside a longer word must not match');
  assert.equal(POSITIVE_HINT_RE.test('maintenance'), false, 'main inside a longer word must not match');
  assert.equal(POSITIVE_HINT_RE.test('nav'), false);

  // The trailing `([^a-z]|$)` group means an inflected hint word does not match;
  // callers must pass class/id/tag tokens, not arbitrary prose.
  assert.equal(NEGATIVE_HINT_RE.test('comments'), false);
  assert.equal(NEGATIVE_HINT_RE.test('Advertisement'), false);
  assert.equal(NEGATIVE_HINT_RE.test('comment'), true);
  assert.equal(NEGATIVE_HINT_RE.test('advert'), true);
});

test('escapeHtml escapes all five significant characters', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml('&<'), '&amp;&lt;', 'ampersand must be escaped first');
  assert.equal(escapeHtml('safe'), 'safe');
});

test('escapeHtml never returns null for degenerate input', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml('中文 <b>'), '中文 &lt;b&gt;');
});

test('clamp keeps in-range values untouched and pulls outliers to the bound', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(1, 1, 10), 1);
  assert.equal(clamp(10, 1, 10), 10);
  assert.equal(clamp(0, 1, 10), 1);
  assert.equal(clamp(11, 1, 10), 10);
  assert.equal(clamp(16.4, 14, 24), 16.4);
  assert.equal(clamp(-0, 1, 10), 1, '-0 is below 1');
});

test('clamp treats non-finite and non-numeric input as min', () => {
  assert.equal(clamp(Number.NaN, 14, 24), 14);
  assert.equal(clamp(Number.POSITIVE_INFINITY, 14, 24), 14);
  assert.equal(clamp(Number.NEGATIVE_INFINITY, 14, 24), 14);
  assert.equal(clamp('20', 14, 24), 14);
  assert.equal(clamp(null, 14, 24), 14);
  assert.equal(clamp(undefined, 14, 24), 14);
});

test('clamp survives malformed bounds', () => {
  assert.equal(clamp(5, 10, 1), 10, 'min wins when the bounds are inverted');
  assert.equal(clamp(5, Number.NaN, 1), 5, 'non-finite min is ignored');
  assert.equal(clamp(5, 1, Number.NaN), 5);
  assert.equal(clamp(Number.NaN, Number.NaN, Number.NaN), Number.NaN);
});
