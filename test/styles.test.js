/**
 * Shadow-root CSS contract (CONTRACTS.md §13): style isolation, no remote resources,
 * and the toolbar's two docking edges.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readerCss } from '../src/core/styles.js';

const css = readerCss();

test('readerCss keeps the shadow root isolated from the page', () => {
  assert.match(css, /:host \{[^}]*all: initial !important/);
  assert.match(css, /:host \{[^}]*position: fixed !important/);
  assert.match(css, /:host \{[^}]*inset: 0 !important/);
  assert.match(css, /@media print \{ \.ezr-toolbar, \.ezr-outline \{ display: none !important \} \}/);
});

test('readerCss references no remote resource', () => {
  assert.equal(/@import|@font-face|url\(/i.test(css), false);
});

test('original-page mode keeps only the toolbar', () => {
  assert.match(css, /:host\(\[data-ezr-original\]\) \{ bottom: auto !important; \}/);
  assert.match(css, /:host\(\[data-ezr-original\]\) \.ezr-body \{ display: none; \}/);
});

test('bottom dock anchors the host to the bottom edge', () => {
  assert.match(css, /:host\(\[data-ezr-original\]\[data-ezr-dock="bottom"\]\) \{ top: auto !important; bottom: 0 !important; \}/);
});

test('bottom dock flips the toolbar rule and the toolbar shadow', () => {
  assert.match(css, /:host\(\[data-ezr-dock="bottom"\]\) \.ezr-toolbar \{[^}]*border-bottom: 0;[^}]*border-top: 2px solid/);
  assert.match(css, /:host\(\[data-ezr-dock="bottom"\]\) \.ezr-toolbar-host \{[^}]*box-shadow: 0 -4px 14px/);
});
