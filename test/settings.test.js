import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fontStackById,
  isCjkDominant,
  mergeSettings,
  normalizeSettings,
  resolveSettings,
  storageKeyFor,
} from '../src/core/settings.js';
import { DEFAULT_SETTINGS, FONT_FAMILIES } from '../src/core/constants.js';

test('normalizeSettings always returns a complete object', () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings('nope'), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(42), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS });
  assert.notEqual(normalizeSettings({}), DEFAULT_SETTINGS, 'a fresh object is returned');
  assert.notEqual(normalizeSettings({}), normalizeSettings({}));
  assert.ok(normalizeSettings(null) !== null);
});

test('normalizeSettings keeps valid values and clamps out-of-range numbers', () => {
  assert.equal(normalizeSettings({ bodyFontSize: 18 }).bodyFontSize, 18);
  assert.equal(normalizeSettings({ bodyFontSize: 100 }).bodyFontSize, 24);
  assert.equal(normalizeSettings({ bodyFontSize: 1 }).bodyFontSize, 14);
  assert.equal(normalizeSettings({ lineHeight: 2.5 }).lineHeight, 2.2);
  assert.equal(normalizeSettings({ lineHeight: 0 }).lineHeight, 1.2);
  assert.equal(normalizeSettings({ gapFactor: 0.5 }).gapFactor, 1.15);
  assert.equal(normalizeSettings({ gapFactor: 99 }).gapFactor, 3);
  assert.equal(normalizeSettings({ gapExtraPx: -4 }).gapExtraPx, 0);
  assert.equal(normalizeSettings({ gapExtraPx: 100 }).gapExtraPx, 24);
  assert.equal(normalizeSettings({ measure: 5 }).measure, 24);
  assert.equal(normalizeSettings({ measure: 500 }).measure, 90);
  assert.equal(normalizeSettings({ zoomMode: 'manual', zoom: 5 }).zoom, 2.5);
  assert.equal(normalizeSettings({ zoomMode: 'manual', zoom: 0.1 }).zoom, 0.6);
});

test('normalizeSettings rejects unusable values field by field', () => {
  const hostile = {
    fontId: 'comic-sans',
    bodyFontSize: Number.NaN,
    lineHeight: Number.POSITIVE_INFINITY,
    gapFactor: '1.6',
    gapExtraPx: null,
    gapOverridePx: '40',
    measure: {},
    headingMode: 'wild',
    splitLines: 'yes',
    capitalizeFirst: 1,
    capitalizeLocales: null,
    zoomMode: 'fit',
    zoom: Number.NaN,
    theme: 'neon',
    showOutline: 0,
    toolbarDock: 'side',
    rememberPerSite: 'true',
    restorePosition: undefined,
  };
  const out = normalizeSettings(hostile);
  assert.deepEqual(out, DEFAULT_SETTINGS);
});

test('normalizeSettings validates the enum and font fields', () => {
  assert.equal(normalizeSettings({ headingMode: 'aggressive' }).headingMode, 'aggressive');
  assert.equal(normalizeSettings({ headingMode: 'conservative' }).headingMode, 'conservative');
  assert.equal(normalizeSettings({ zoomMode: 'manual' }).zoomMode, 'manual');
  assert.equal(normalizeSettings({ theme: 'sepia' }).theme, 'sepia');
  assert.equal(normalizeSettings({ theme: 'auto' }).theme, 'auto');
  assert.equal(normalizeSettings({ toolbarDock: 'bottom' }).toolbarDock, 'bottom');
  assert.equal(normalizeSettings({ toolbarDock: 'top' }).toolbarDock, 'top');
  assert.equal(normalizeSettings({ fontId: 'mono-consolas' }).fontId, 'mono-consolas');
  assert.equal(normalizeSettings({ fontId: 'serif-palatino' }).fontId, 'serif-palatino');
  assert.equal(normalizeSettings({ capitalizeLocales: 'tr' }).capitalizeLocales, 'tr');
  assert.equal(normalizeSettings({ splitLines: false }).splitLines, false);
  assert.equal(normalizeSettings({ rememberPerSite: false }).rememberPerSite, false);
});

test('normalizeSettings handles gapOverridePx specially', () => {
  assert.equal(normalizeSettings({ gapOverridePx: null }).gapOverridePx, null);
  assert.equal(normalizeSettings({ gapOverridePx: 40 }).gapOverridePx, 40);
  assert.equal(normalizeSettings({ gapOverridePx: 0 }).gapOverridePx, 0);
  assert.equal(normalizeSettings({ gapOverridePx: -5 }).gapOverridePx, null, 'negative overrides fall back to the formula');
  assert.equal(normalizeSettings({ gapOverridePx: Number.NaN }).gapOverridePx, null);
  assert.equal(normalizeSettings({ gapOverridePx: '40' }).gapOverridePx, null);
});

test('normalizeSettings drops unknown fields and keeps the documented key set', () => {
  const out = normalizeSettings({ ...DEFAULT_SETTINGS, evil: true, __proto__: { polluted: true } });
  assert.equal(Object.hasOwn(out, 'evil'), false);
  assert.equal(Object.hasOwn(out, 'polluted'), false);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.equal(({}).polluted, undefined);
});

test('normalizeSettings never mutates its input', () => {
  const raw = Object.freeze({ bodyFontSize: 99, theme: 'dark', junk: 1 });
  const out = normalizeSettings(raw);
  assert.deepEqual(raw, { bodyFontSize: 99, theme: 'dark', junk: 1 });
  assert.equal(out.bodyFontSize, 24);
  assert.equal(out.theme, 'dark');
});

test('mergeSettings shallow merges one level into a new object', () => {
  assert.deepEqual(mergeSettings({ a: 1, b: 2 }, { b: 3, c: 4 }), { a: 1, b: 3, c: 4 });
  assert.deepEqual(mergeSettings({ a: 1 }, {}), { a: 1 });
  assert.deepEqual(mergeSettings({}, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeSettings(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeSettings({ a: 1 }, null), { a: 1 });
  assert.deepEqual(mergeSettings({ a: 1 }, 'nope'), { a: 1 });
  assert.deepEqual(mergeSettings({ a: 1 }, { a: undefined }), { a: 1 }, 'undefined does not wipe a value');
  assert.deepEqual(mergeSettings({ nested: { x: 1 } }, { nested: { y: 2 } }), { nested: { y: 2 } }, 'merging is not deep');
});

test('mergeSettings does not mutate either argument', () => {
  const base = Object.freeze({ a: 1, b: 2 });
  const override = Object.freeze({ b: 9 });
  const out = mergeSettings(base, override);
  assert.deepEqual(base, { a: 1, b: 2 });
  assert.deepEqual(override, { b: 9 });
  assert.notEqual(out, base);
});

test('resolveSettings applies byOrigin overrides when rememberPerSite is on', () => {
  const byOrigin = {
    'https://a.example': { theme: 'dark', bodyFontSize: 20 },
    'https://b.example': { headingMode: 'aggressive' },
  };
  const a = resolveSettings(DEFAULT_SETTINGS, byOrigin, 'https://a.example');
  assert.equal(a.theme, 'dark');
  assert.equal(a.bodyFontSize, 20);
  assert.equal(a.lineHeight, 1.6, 'untouched fields keep their defaults');
  assert.equal(Object.keys(a).length, Object.keys(DEFAULT_SETTINGS).length);

  const b = resolveSettings(DEFAULT_SETTINGS, byOrigin, 'https://b.example');
  assert.equal(b.headingMode, 'aggressive');
  assert.equal(b.theme, 'light');
});

test('resolveSettings ignores byOrigin when rememberPerSite is off or the origin is unknown', () => {
  const byOrigin = { 'https://a.example': { theme: 'dark' } };
  assert.equal(resolveSettings({ ...DEFAULT_SETTINGS, rememberPerSite: false }, byOrigin, 'https://a.example').theme, 'light');
  assert.equal(resolveSettings(DEFAULT_SETTINGS, byOrigin, 'https://unknown.example').theme, 'light');
  assert.equal(resolveSettings(DEFAULT_SETTINGS, {}, 'https://a.example').theme, 'light');
  assert.equal(resolveSettings(DEFAULT_SETTINGS, null, 'https://a.example').theme, 'light');
  assert.equal(resolveSettings(DEFAULT_SETTINGS, byOrigin, '').theme, 'light');
  assert.equal(resolveSettings(null, byOrigin, 'https://unknown.example').theme, 'light');
  assert.equal(resolveSettings(undefined, byOrigin, 'https://a.example').rememberPerSite, true);
});

test('resolveSettings validates per-origin garbage and never mutates its inputs', () => {
  const defaults = Object.freeze({ ...DEFAULT_SETTINGS });
  const byOrigin = Object.freeze({ 'https://a.example': Object.freeze({ bodyFontSize: 999, theme: 'neon', junk: 1 }) });
  const out = resolveSettings(defaults, byOrigin, 'https://a.example');
  assert.equal(out.bodyFontSize, 24, 'per-origin values are clamped too');
  assert.equal(out.theme, 'light', 'unknown enums fall back to the default');
  assert.equal(Object.hasOwn(out, 'junk'), false);
  assert.deepEqual(defaults, { ...DEFAULT_SETTINGS });
  assert.deepEqual(byOrigin['https://a.example'], { bodyFontSize: 999, theme: 'neon', junk: 1 });
});

test('isCjkDominant uses a strict 30% code-point ratio', () => {
  assert.equal(isCjkDominant('中文字符测试内容'), true);
  assert.equal(isCjkDominant('这是一句话。'), true);
  assert.equal(isCjkDominant('日本語のテスト'), true);
  assert.equal(isCjkDominant('한국어 테스트'), true);
  assert.equal(isCjkDominant('Hello world'), false);
  assert.equal(isCjkDominant('Hello 世界 world'), false);
  assert.equal(isCjkDominant('中文日abcdefg'), false, 'exactly 30% is not dominant');
  assert.equal(isCjkDominant('中文日韩abcdef'), true, '40% is dominant');
  assert.equal(isCjkDominant(''), false);
  assert.equal(isCjkDominant('   '), false);
  assert.equal(isCjkDominant('12345'), false);
});

test('isCjkDominant tolerates degenerate input', () => {
  assert.equal(isCjkDominant(null), false);
  assert.equal(isCjkDominant(undefined), false);
  assert.equal(isCjkDominant(42), false);
  assert.equal(isCjkDominant({}), false);
  assert.equal(isCjkDominant(['ab']), false);
});

test('fontStackById resolves known ids and falls back to the first family', () => {
  assert.equal(fontStackById('serif-georgia'), FONT_FAMILIES[0].stack);
  for (const family of FONT_FAMILIES) {
    assert.equal(fontStackById(family.id), family.stack);
    assert.ok(fontStackById(family.id).length > 0);
  }
  assert.equal(fontStackById('nope'), FONT_FAMILIES[0].stack);
  assert.equal(fontStackById(null), FONT_FAMILIES[0].stack);
  assert.equal(fontStackById(undefined), FONT_FAMILIES[0].stack);
  assert.equal(fontStackById(42), FONT_FAMILIES[0].stack);
  assert.ok(fontStackById('mono-consolas').includes('Consolas'));
});

test('storageKeyFor builds the documented keys', () => {
  assert.equal(storageKeyFor('', 'settings'), 'ezr:settings:default');
  assert.equal(storageKeyFor('default', 'settings'), 'ezr:settings:default');
  assert.equal(storageKeyFor(null, 'settings'), 'ezr:settings:default');
  assert.equal(storageKeyFor(undefined, 'settings'), 'ezr:settings:default');
  assert.equal(storageKeyFor('https://a.example', 'settings'), 'ezr:settings:https://a.example');
  assert.equal(storageKeyFor('', 'pos'), 'ezr:pos');
  assert.equal(storageKeyFor(null, 'pos'), 'ezr:pos');
  assert.equal(storageKeyFor('https://a.example', 'pos'), 'ezr:pos:https://a.example');
  assert.equal(storageKeyFor(' https://a.example ', 'pos'), 'ezr:pos:https://a.example', 'origins are trimmed');
  assert.equal(storageKeyFor('x', 'unknown'), 'ezr:settings:x', 'unknown kinds behave like settings');
});

test('storageKeyFor keys are single-line and non-empty for every input', () => {
  for (const origin of ['', 'default', 'https://a.example', null, undefined, 42, {}]) {
    for (const kind of ['settings', 'pos']) {
      const key = storageKeyFor(origin, kind);
      assert.equal(typeof key, 'string');
      assert.ok(key.length > 0);
      assert.ok(!/[\r\n]/.test(key));
      assert.ok(key.startsWith('ezr:'));
    }
  }
});
