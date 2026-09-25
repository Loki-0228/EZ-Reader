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

test('original-page mode keeps the bars and lets the page receive events', () => {
  assert.match(css, /:host\(\[data-ezr-original\]\) \{ pointer-events: none !important; \}/);
  assert.match(css, /:host\(\[data-ezr-original\]\) \.ezr-body \{ display: none; \}/);
});

test('original-page mode pins the toolbar slots to both window edges', () => {
  assert.match(css, /:host\(\[data-ezr-original\]\) \.ezr-toolbar-slot \{ position: absolute; left: 0; right: 0; pointer-events: auto; \}/);
  assert.match(css, /:host\(\[data-ezr-original\]\) \.ezr-toolbar-slot-top \{ top: 0; \}/);
  assert.match(css, /:host\(\[data-ezr-original\]\) \.ezr-toolbar-slot-bottom \{ bottom: 0; \}/);
});

test('bottom dock flips the toolbar rule and the slot shadow', () => {
  assert.match(css, /\.ezr-toolbar-host\[data-ezr-dock="bottom"\] \.ezr-toolbar \{[^}]*border-bottom: 0;[^}]*border-top: 2px solid/);
  assert.match(css, /\.ezr-toolbar-slot-bottom \{ box-shadow: 0 -4px 14px/);
});
