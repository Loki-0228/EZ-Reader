import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickBest, scoreCandidate } from '../src/core/score.js';

test('scoreCandidate applies the documented formula', () => {
  assert.equal(scoreCandidate({ paraCount: 3, textLength: 1000, linkTextLength: 0 }), 3 + 10);
  assert.equal(scoreCandidate({ paraCount: 3, textLength: 1000, linkTextLength: 125 }), 3 + 10 - 1);
  assert.equal(scoreCandidate({ paraCount: 0, textLength: 0, linkTextLength: 0 }), 0);
  assert.equal(scoreCandidate({ paraCount: 1.5, textLength: 250 }), 1.5 + 2.5);
});

test('text length is capped at 5000 characters', () => {
  const capped = scoreCandidate({ paraCount: 0, textLength: 5000 });
  const beyond = scoreCandidate({ paraCount: 0, textLength: 50000 });
  assert.equal(capped, 50);
  assert.equal(beyond, 50, 'length beyond the cap adds nothing');
});

test('positive and negative hint bonuses are applied', () => {
  const base = scoreCandidate({ paraCount: 1, textLength: 100 });
  assert.equal(scoreCandidate({ paraCount: 1, textLength: 100, className: 'article-body' }), base + 3);
  assert.equal(scoreCandidate({ paraCount: 1, textLength: 100, tagName: 'ARTICLE' }), base + 3);
  assert.equal(scoreCandidate({ paraCount: 1, textLength: 100, id: 'main' }), base + 3);
  assert.equal(scoreCandidate({ paraCount: 1, textLength: 100, className: 'site-footer' }), base - 6);
  assert.equal(scoreCandidate({ paraCount: 1, textLength: 100, className: 'nav' }), base - 6);
  assert.equal(
    scoreCandidate({ paraCount: 1, textLength: 100, className: 'nav article-body' }),
    base + 3 - 6,
    'both hints can fire',
  );
});

test('a link density above 0.5 always produces a negative score', () => {
  const overLinked = {
    paraCount: 200,
    textLength: 5000,
    linkTextLength: 2550,
    className: 'main-article-body',
  };
  const score = scoreCandidate(overLinked);
  assert.ok(score < 0, `over-linked candidates must score negative, got ${score}`);
  assert.equal(score, -1, 'only pulled down to the negative floor, not further');

  const exactlyHalf = scoreCandidate({ paraCount: 0, textLength: 100, linkTextLength: 50 });
  assert.equal(exactlyHalf, 0 + 1 - 4, 'exactly 0.5 is not "above 0.5"');
  assert.ok(exactlyHalf < 0);

  const emptyText = scoreCandidate({ paraCount: 0, textLength: 0, linkTextLength: 10 });
  assert.equal(emptyText, 0 - 8, 'text made only of links is fully over-linked');
  assert.ok(emptyText < 0);
  assert.ok(scoreCandidate({ paraCount: 0, textLength: 0, linkTextLength: 0 }) === 0);
});

test('scoreCandidate tolerates missing and hostile stats', () => {
  assert.equal(scoreCandidate(), 0);
  assert.equal(scoreCandidate(null), 0);
  assert.equal(scoreCandidate(undefined), 0);
  assert.equal(scoreCandidate({}), 0);
  assert.equal(scoreCandidate({ paraCount: Number.NaN, textLength: Number.NaN, linkTextLength: Number.NaN }), 0);
  assert.equal(scoreCandidate({ paraCount: Number.POSITIVE_INFINITY, textLength: -500 }), 0);
  assert.equal(scoreCandidate({ paraCount: '3', textLength: '1000', className: 42 }), 0, 'strings are ignored');
  assert.equal(scoreCandidate({ paraCount: 1, textLength: 100, linkTextLength: 500 }), 1 + 1 - 8, 'link text cannot exceed text length');
});

test('pickBest returns the highest scoring candidate', () => {
  const weak = { stats: { paraCount: 1, textLength: 100 }, depth: 1, path: 'a' };
  const strong = { stats: { paraCount: 9, textLength: 4000 }, depth: 5, path: 'b' };
  assert.equal(pickBest([weak, strong]), strong);
  assert.equal(pickBest([strong, weak]), strong);
});

test('pickBest breaks ties by the smallest depth, then by input order', () => {
  const shallow = { stats: { paraCount: 4, textLength: 500 }, depth: 2, path: 'shallow' };
  const deep = { stats: { paraCount: 4, textLength: 500 }, depth: 7, path: 'deep' };
  assert.equal(pickBest([deep, shallow]), shallow);
  assert.equal(pickBest([shallow, deep]), shallow);

  const first = { stats: { paraCount: 4, textLength: 500 }, depth: 3, path: 'first' };
  const second = { stats: { paraCount: 4, textLength: 500 }, depth: 3, path: 'second' };
  assert.equal(pickBest([first, second]), first, 'a full tie keeps the first candidate');

  const noDepth = { stats: { paraCount: 4, textLength: 500 }, path: 'no-depth' };
  assert.equal(pickBest([noDepth, first]), first, 'a missing depth counts as Infinity');
});

test('pickBest returns null for empty or invalid candidate lists', () => {
  assert.equal(pickBest([]), null);
  assert.equal(pickBest(null), null);
  assert.equal(pickBest(undefined), null);
  assert.equal(pickBest('nope'), null);
});

test('pickBest prefers positive content over over-linked navigation', () => {
  const nav = {
    stats: { paraCount: 30, textLength: 3000, linkTextLength: 2000, className: 'nav-menu' },
    depth: 1,
    path: '#nav',
  };
  const article = {
    stats: { paraCount: 8, textLength: 4000, linkTextLength: 100, className: 'article-body' },
    depth: 4,
    path: '#main > article',
  };
  assert.ok(scoreCandidate(nav.stats) < 0);
  assert.equal(pickBest([nav, article]), article);
});

test('scoreCandidate and pickBest never mutate their input', () => {
  const stats = Object.freeze({ paraCount: 2, textLength: 300, linkTextLength: 10, className: 'article' });
  const candidate = Object.freeze({ stats, depth: 2, path: 'p' });
  const list = Object.freeze([candidate]);
  const before = JSON.stringify(candidate);
  scoreCandidate(stats);
  pickBest(list);
  assert.equal(JSON.stringify(candidate), before);
  assert.equal(pickBest(list), candidate);
});
