/**
 * Reader view CSS and CSS custom properties.
 *
 * `readerCss()` is one self-contained template string for a shadow root: no
 * `@import`, no `@font-face`, no remote resource of any kind. All theming flows
 * through the custom properties returned by `cssVarsFor()`.
 */

import { HEADING_FONT_SIZES } from './constants.js';
import { paragraphGapPx } from './paragraph-gap.js';
import { fontStackById, normalizeSettings } from './settings.js';

/** Every custom property the reader view consumes. @type {ReadonlyArray<string>} */
export const CSS_VARS = Object.freeze([
  '--ezr-font',
  '--ezr-size-body',
  '--ezr-size-h1',
  '--ezr-size-h2',
  '--ezr-size-h3',
  '--ezr-size-h4',
  '--ezr-size-h5',
  '--ezr-size-h6',
  '--ezr-lh',
  '--ezr-gap',
  '--ezr-measure',
  '--ezr-scale',
  '--ezr-fg',
  '--ezr-bg',
  '--ezr-muted',
  '--ezr-border',
  '--ezr-accent',
  '--ezr-accent-fg',
]);

/** @type {Readonly<Record<string, Readonly<{fg: string, bg: string, muted: string, border: string, accent: string, accentFg: string}>>>} */
const THEME_COLORS = Object.freeze({
  light: Object.freeze({ fg: '#1a1a1a', bg: '#ffffff', muted: '#6b7280', border: '#e5e7eb', accent: '#3c73cb', accentFg: '#ffffff' }),
  sepia: Object.freeze({ fg: '#3b2f22', bg: '#f7f1e3', muted: '#7a6a52', border: '#e2d6bd', accent: '#3c73cb', accentFg: '#ffffff' }),
  dark: Object.freeze({ fg: '#e6e6e6', bg: '#16181c', muted: '#9aa0a6', border: '#2c2f36', accent: '#8cb6f3', accentFg: '#12243f' }),
});

/** Palette used for `theme: 'auto'` (the dark override lives in `readerCss`). @type {string} */
const AUTO_THEME_FALLBACK = 'light';

/**
 * Complete CSS for the reader shadow root.
 * @returns {string} one self-contained CSS string, safe to inject into a `<style>`
 */
export function readerCss() {
  return `/* EZ-Reader reader view. Self-contained: no network resources, no remote fonts. */
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; }

:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483647 !important;
  --ezr-font: Georgia, 'Iowan Old Style', 'Times New Roman', serif;
  --ezr-size-body: 16px;
  --ezr-size-h1: 30px;
  --ezr-size-h2: 25px;
  --ezr-size-h3: 21px;
  --ezr-size-h4: 18px;
  --ezr-size-h5: 17px;
  --ezr-size-h6: 16px;
  --ezr-lh: 1.6;
  --ezr-gap: 43px;
  --ezr-measure: 44rem;
  --ezr-scale: 1;
  --ezr-fg: #1a1a1a;
  --ezr-bg: #ffffff;
  --ezr-muted: #6b7280;
  --ezr-border: #e5e7eb;
  --ezr-accent: #3c73cb;
  --ezr-accent-fg: #ffffff;
}

.ezr-root { line-height: normal; letter-spacing: normal; word-spacing: normal; text-transform: none; font-variant: normal; text-align: left; }

.ezr-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  overscroll-behavior: contain;
  background: var(--ezr-bg);
  color: var(--ezr-fg);
  font-family: var(--ezr-font);
  accent-color: var(--ezr-accent);
  -webkit-text-size-adjust: 100%;
  text-rendering: optimizeLegibility;
}

.ezr-toolbar-host {
  flex: none;
  position: relative;
  z-index: 2;
  box-shadow: 0 4px 14px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.12);
}
.ezr-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }

/* Original-page mode retains only the return toolbar, so the page is clickable. */
:host([data-ezr-original]) { bottom: auto !important; }
:host([data-ezr-original]) .ezr-root {
  height: auto;
  box-shadow: 0 6px 20px rgba(0,0,0,.2), 0 1px 4px rgba(0,0,0,.14);
}
:host([data-ezr-original]) .ezr-body { display: none; }

/* Bottom dock: the toolbar sits flush with the viewport bottom, so its border and shadow are inverted. */
:host([data-ezr-dock="bottom"]) .ezr-toolbar-host {
  box-shadow: 0 -4px 14px rgba(0,0,0,.18), 0 -1px 3px rgba(0,0,0,.12);
}
:host([data-ezr-dock="bottom"]) .ezr-toolbar {
  border-bottom: 0;
  border-top: 2px solid color-mix(in srgb, var(--ezr-fg) 24%, var(--ezr-bg));
}
:host([data-ezr-original][data-ezr-dock="bottom"]) { top: auto !important; bottom: 0 !important; }
:host([data-ezr-original][data-ezr-dock="bottom"]) .ezr-root {
  box-shadow: 0 -6px 20px rgba(0,0,0,.2), 0 -1px 4px rgba(0,0,0,.14);
}

.ezr-root *,
.ezr-root *::before,
.ezr-root *::after { box-sizing: border-box; }

.ezr-article {
  zoom: var(--ezr-scale);
  max-width: var(--ezr-measure);
  margin: 0 auto;
  padding: 2.5rem 1.5rem 6rem;
  background: var(--ezr-bg);
  color: var(--ezr-fg);
  font-family: var(--ezr-font);
  font-size: var(--ezr-size-body);
  line-height: var(--ezr-lh);
  overflow-wrap: break-word;
}

.ezr-article h1,
.ezr-article h2,
.ezr-article h3,
.ezr-article h4,
.ezr-article h5,
.ezr-article h6 { margin: 1.4em 0 0.5em; font-weight: 700; line-height: 1.25; }

.ezr-article h1:first-child,
.ezr-article h2:first-child,
.ezr-article h3:first-child { margin-top: 0; }

.ezr-h1 { font-size: var(--ezr-size-h1); }
.ezr-h2 { font-size: var(--ezr-size-h2); }
.ezr-h3 { font-size: var(--ezr-size-h3); }
.ezr-h4 { font-size: var(--ezr-size-h4); }
.ezr-h5 { font-size: var(--ezr-size-h5); }
.ezr-h6 { font-size: var(--ezr-size-h6); }

.ezr-para { display: block; list-style: none; margin: 0 0 var(--ezr-gap); }

/*
 * "每个单词首字母大写" is a rendering-time effect, never a text rewrite: render.js
 * wraps each eligible word in span[data-ezr-w] and the uppercase comes from
 * ::first-letter here. ::first-letter only applies to block containers, so the
 * marker is an inline-block, which is also what keeps copy/paste and find-in-page
 * reading the original string.
 *
 * IMPORTANT: this whole block is inside a JS template literal, so it must never contain
 * a backtick character — one would terminate the CSS string and break the bundle.
 */
.ezr-article [data-ezr-w] {
  display: inline-block;
  white-space: pre;
}
.ezr-article [data-ezr-w]::first-letter { text-transform: uppercase !important; }

/* Inline placeholder for an image's alt text: offline, no network, still informative. */
.ezr-alt {
  display: inline-block;
  margin: 0 0.15em;
  padding: 0 0.4em;
  border: 1px dashed var(--ezr-border);
  border-radius: 4px;
  color: var(--ezr-muted);
  font-size: 0.9em;
}

.ezr-list { margin: 0 0 var(--ezr-gap); padding-left: 1.6em; }
.ezr-li { margin: 0 0 calc(var(--ezr-gap) / 3); }

.ezr-quote {
  margin: 0 0 var(--ezr-gap);
  padding: 0.1em 0 0.1em 1em;
  border-left: 3px solid var(--ezr-border);
  color: var(--ezr-muted);
  font-style: italic;
}

.ezr-code {
  margin: 0 0 var(--ezr-gap);
  padding: 0.8em 1em;
  overflow-x: auto;
  background: var(--ezr-border);
  color: var(--ezr-fg);
  font-family: Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', 'Courier New', monospace;
  font-size: 0.92em;
  line-height: 1.5;
  white-space: pre-wrap;
}

.ezr-code code { font-family: inherit; font-size: inherit; background: none; }

.ezr-table-wrap { margin: 0 0 var(--ezr-gap); overflow-x: auto; }
.ezr-table-wrap table { border-collapse: collapse; width: 100%; }
.ezr-table-wrap td { border: 1px solid var(--ezr-border); padding: 0.4em 0.6em; }

.ezr-hr { margin: var(--ezr-gap) 0; border: 0; border-top: 1px solid var(--ezr-border); }

.ezr-toolbar {
  position: sticky;
  top: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  padding: 0.5rem 1rem;
  background: var(--ezr-bg);
  border-bottom: 2px solid color-mix(in srgb, var(--ezr-fg) 24%, var(--ezr-bg));
  color: var(--ezr-muted);
  font-family: var(--ezr-font);
}

.ezr-outline {
  max-width: var(--ezr-measure);
  margin: 0 auto;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--ezr-border);
  color: var(--ezr-muted);
  font-family: var(--ezr-font);
}

.ezr-outline a { color: inherit; text-decoration: none; }

/* Reading controls use their own UI typography, independent of the article font. */
.ezr-toolbar {
  padding: 10px 16px;
  gap: 8px;
  font: 13px/1.4 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.ezr-title-chip { flex: 1 1 180px; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ezr-toolbar button, .ezr-toolbar select {
  min-height: 30px; padding: 4px 9px; border: 1px solid var(--ezr-border);
  border-radius: 7px; background: var(--ezr-bg); color: var(--ezr-fg); font: inherit; cursor: pointer;
}
.ezr-toolbar button:hover { background: color-mix(in srgb, var(--ezr-fg) 6%, var(--ezr-bg)); }
.ezr-toolbar button:disabled, .ezr-toolbar select:disabled { opacity: .38; cursor: not-allowed; }
.ezr-toolbar button:disabled:hover { background: var(--ezr-bg); }
.ezr-toolbar .ezr-btn-original { color: var(--ezr-accent); font-weight: 600; }
.ezr-reading-actions { display: inline-flex; flex: none; border: 1px solid var(--ezr-accent); border-radius: 8px; }
.ezr-toolbar .ezr-reading-actions button { border: 0; border-radius: 0; white-space: nowrap; }
.ezr-toolbar .ezr-reading-actions .ezr-btn-original { border-right: 1px solid var(--ezr-accent); border-radius: 7px 0 0 7px; }
.ezr-toolbar .ezr-reading-actions .ezr-btn-pick { border-radius: 0 7px 7px 0; }
.ezr-zoom, .ezr-font-field { display: inline-flex; align-items: center; gap: 5px; }
.ezr-zoom-label { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }
.ezr-toolbar :focus-visible { outline: 2px solid var(--ezr-accent); outline-offset: 2px; }

.ezr-toolbar[hidden] { display:none!important; }
.ezr-toolbar { display:grid; grid-template-columns:var(--ezr-toolbar-title-width, clamp(120px, 15vw, 210px)) minmax(0, 1fr) 32px; align-items:start; gap:12px; padding:10px 16px; }
.ezr-title-chip { max-width:none; min-width:0; align-self:center; }
.ezr-toolbar .ezr-reading-pdf .ezr-btn-original {border-right:0;border-radius:7px;}
.ezr-toolbar-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0; }
.ezr-toolbar .ezr-btn-translation[aria-expanded="true"] { color:var(--ezr-accent); border-color:var(--ezr-accent); background:color-mix(in srgb,var(--ezr-accent) 7%,var(--ezr-bg)); }
.ezr-toolbar .ezr-toolbar-close, .ezr-full-bar .ezr-toolbar-close { display:grid; place-items:center; width:32px; min-width:32px; height:30px; padding:0; color:var(--ezr-muted); border:0; background:transparent; border-radius:6px; cursor:pointer; }
.ezr-toolbar .ezr-toolbar-close:hover, .ezr-full-bar .ezr-toolbar-close:hover { color:var(--ezr-fg); background:color-mix(in srgb,var(--ezr-fg) 7%,var(--ezr-bg)); }
@media(max-width:760px) { .ezr-toolbar { grid-template-columns:minmax(0,1fr) 32px; } .ezr-title-chip { display:none; } }

/* Settings is a separate drawer, outside the scrollable reading content. */
.ezr-settings-backdrop { position: fixed; inset: 0; z-index: 2147483644; background: rgba(17, 24, 39, .22); }
.ezr-settings[hidden], .ezr-settings [hidden], .ezr-settings-backdrop[hidden] { display: none !important; }
.ezr-settings {
  --ezr-panel-soft: color-mix(in srgb, var(--ezr-fg) 4%, var(--ezr-bg));
  --ezr-panel-muted: color-mix(in srgb, var(--ezr-fg) 66%, var(--ezr-bg));
  display: flex; flex-direction: column; text-align: left;
  font: 13px/1.5 'Segoe UI', 'Microsoft YaHei', sans-serif;
  letter-spacing: normal; color-scheme: light;
}
.ezr-settings.is-open { animation: ezr-drawer-in 180ms ease-out; }
@keyframes ezr-drawer-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
.ezr-settings-head {
  flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 26px 24px 22px; border-bottom: 1px solid var(--ezr-border);
}
.ezr-settings-kicker { color: var(--ezr-accent); font-size: 10px; font-weight: 700; letter-spacing: 2px; }
.ezr-settings-title { margin: 6px 0 4px; font-size: 23px; line-height: 1.35; font-weight: 650; letter-spacing: -.5px; }
.ezr-settings-description { margin: 0; color: var(--ezr-panel-muted); font-size: 12px; }
.ezr-settings .ezr-settings-close {
  flex: none; display: grid; place-items: center; width: 32px; height: 32px;
  padding: 0; border: 1px solid var(--ezr-border); border-radius: 50%;
  background: var(--ezr-bg); color: var(--ezr-panel-muted); font: 22px/1 sans-serif; cursor: pointer;
}
.ezr-settings-close:hover { background: var(--ezr-panel-soft); color: var(--ezr-fg); }
.ezr-settings-scroll { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 24px 24px; scrollbar-width: thin; }
.ezr-settings-section { padding: 23px 0 5px; }
.ezr-settings-section + .ezr-settings-section { border-top: 1px solid var(--ezr-border); margin-top: 14px; }
.ezr-settings-section-title { display: flex; align-items: center; gap: 9px; margin: 0 0 19px; font-size: 13px; font-weight: 650; }
.ezr-settings-subtitle { margin: 8px 0 18px; padding-top: 18px; border-top: 1px solid var(--ezr-border); font-size: 12px; }
.ezr-settings input:disabled, .ezr-settings select:disabled { opacity: .45; cursor: not-allowed; }
.ezr-section-number { color: var(--ezr-accent); font: 11px/1.4 Consolas, monospace; letter-spacing: .5px; }
.ezr-settings .ezr-field { display: flex; flex-direction: column; gap: 8px; margin: 0 0 18px; }
.ezr-settings .ezr-field-label { font-size: 12px; font-weight: 550; }
.ezr-settings .ezr-select {
  width: 100%; min-height: 39px; padding: 8px 10px; border: 1px solid var(--ezr-border);
  border-radius: 8px; background: var(--ezr-panel-soft); color: var(--ezr-fg); font: inherit; cursor: pointer;
}
.ezr-range-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ezr-settings .ezr-readout {
  min-width: 47px; padding: 3px 7px; border: 1px solid var(--ezr-border); border-radius: 6px;
  background: var(--ezr-panel-soft); color: var(--ezr-fg); text-align: center;
  font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.ezr-settings .ezr-range {
  appearance: none; width: 100%; height: 20px; margin: 0; cursor: pointer; background: transparent;
}
.ezr-settings .ezr-range::-webkit-slider-runnable-track {
  height: 4px; border-radius: 4px;
  background: linear-gradient(to right, var(--ezr-accent) 0%, var(--ezr-accent) var(--ezr-range-fill, 0%), var(--ezr-border) var(--ezr-range-fill, 0%), var(--ezr-border) 100%);
}
.ezr-settings .ezr-range::-webkit-slider-thumb {
  appearance: none; height: 15px; width: 15px; margin-top: -5.5px; border: 3px solid var(--ezr-bg);
  border-radius: 50%; background: var(--ezr-accent); box-shadow: 0 0 0 1px var(--ezr-accent), 0 2px 5px rgba(0,0,0,.13);
}
.ezr-range-limits { display: flex; justify-content: space-between; color: var(--ezr-panel-muted); font-size: 10px; margin-top: -5px; }
.ezr-settings .ezr-gap-reset {
  display: block; margin: -10px 0 18px auto; padding: 2px 0; border: 0;
  color: var(--ezr-accent); background: none; font: inherit; font-size: 11px; line-height: 1.5; cursor: pointer;
}
.ezr-settings .ezr-field-check { flex-direction: row; align-items: center; justify-content: space-between; gap: 18px; }
.ezr-switch-copy { display: flex; flex-direction: column; gap: 3px; }
.ezr-field-description { color: var(--ezr-panel-muted); font-size: 11px; font-weight: 400; }
.ezr-settings .ezr-check {
  flex: none; appearance: none; position: relative; width: 34px; height: 20px; margin: 0;
  border: 1px solid var(--ezr-border); border-radius: 20px; background: var(--ezr-border); cursor: pointer;
}
.ezr-settings .ezr-check::after {
  content: ''; position: absolute; top: 2px; left: 2px; height: 14px; width: 14px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.16); transition: transform 140ms ease;
}
.ezr-settings .ezr-check:checked { background: var(--ezr-accent); border-color: var(--ezr-accent); }
.ezr-settings .ezr-check:checked::after { transform: translateX(14px); }
.ezr-theme-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.ezr-theme-option { position: relative; display: flex; flex-direction: column; align-items: center; gap: 7px; cursor: pointer; }
.ezr-theme-radio { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.ezr-theme-sample {
  display: grid; place-items: center; width: 100%; height: 48px; border: 1px solid var(--ezr-border);
  border-radius: 8px; font: 23px/1 Georgia, serif;
}
.ezr-theme-sample.ezr-theme-light { background: #fff; color: #1a1a1a; }
.ezr-theme-sample.ezr-theme-sepia { background: #f7f1e3; color: #564731; }
.ezr-theme-sample.ezr-theme-dark { background: #16181c; color: #e6e6e6; }
.ezr-theme-sample.ezr-theme-auto { background: linear-gradient(120deg, #fff 50%, #16181c 50%); color: #3c73cb; }
.ezr-theme-name { font-size: 11px; color: var(--ezr-panel-muted); }
.ezr-theme-radio:checked + .ezr-theme-sample { border: 2px solid var(--ezr-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ezr-accent) 14%, transparent); }
.ezr-theme-radio:checked ~ .ezr-theme-name { color: var(--ezr-fg); font-weight: 600; }
.ezr-theme-radio:focus-visible + .ezr-theme-sample { outline: 2px solid var(--ezr-accent); outline-offset: 3px; }
.ezr-settings-foot {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 17px 24px; border-top: 1px solid var(--ezr-border); background: var(--ezr-panel-soft);
}
.ezr-settings-reset, .ezr-translation-config {
  padding: 7px 11px; border: 1px solid var(--ezr-border); border-radius: 7px;
  background: var(--ezr-bg); color: var(--ezr-fg); font: inherit; cursor: pointer;
}
.ezr-settings-live { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ezr-panel-muted); }
.ezr-settings-live::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--ezr-accent); }
.ezr-translation-config { margin: 4px 0 14px; }
.ezr-translation {
  position: fixed; z-index: 2147483643; max-width: calc(100% - 20px); max-height: calc(100vh - 24px);
  overflow-y: auto; padding: 15px; border: 1px solid var(--ezr-border); border-radius: 12px;
  box-shadow: 0 12px 38px rgba(0,0,0,.2); background: var(--ezr-bg); color: var(--ezr-fg);
  font: 13px/1.65 'Segoe UI', 'Microsoft YaHei', sans-serif; text-align: left;
  overflow-wrap: anywhere; overscroll-behavior: contain;
}
.ezr-translation[hidden] { display: none !important; }
.ezr-translation [hidden] { display: none !important; }
.ezr-translation-head, .ezr-translation-actions { display: flex; align-items: center; gap: 8px; }
.ezr-translation-head { justify-content: space-between; font-weight: 600; margin-bottom: 9px; }
.ezr-translation button { border: 1px solid var(--ezr-border); border-radius: 6px; background: var(--ezr-bg); color: var(--ezr-fg); font: inherit; padding: 5px 10px; cursor: pointer; }
.ezr-translation button:disabled { opacity: .55; cursor: wait; }
.ezr-translation button:focus-visible { outline: 2px solid var(--ezr-accent); outline-offset: 2px; }
.ezr-translation .ezr-translation-close { border: 0; padding: 0 6px; font-size: 21px; line-height: 1.2; }
.ezr-translation-source { color: var(--ezr-muted); max-height: 70px; overflow: auto; margin-bottom: 12px; }
.ezr-translation .ezr-translation-actions button[aria-pressed="true"] { background: var(--ezr-accent); border-color: var(--ezr-accent); color: var(--ezr-accent-fg); }
.ezr-translation-options { margin-left: auto; }
.ezr-translation-result { margin-top: 14px; white-space: pre-wrap; user-select: text; }
.ezr-translation-result:empty { display: none; }
.ezr-translation-detail { color: var(--ezr-muted); font-size: 11px; margin-top: 10px; }
.ezr-translation.is-word-card { padding: 19px; }
.is-word-card .ezr-translation-head { color: var(--ezr-muted); font-size: 10px; letter-spacing: 1px; margin-bottom: 12px; }
.is-word-card .ezr-translation-source { font: 600 25px/1.3 Georgia, 'Microsoft YaHei', serif; color: var(--ezr-fg); margin-bottom: 5px; }
.ezr-word-meta { font-size: 12px; color: var(--ezr-muted); margin-bottom: 12px; }
.ezr-word-meta:empty { display: none; }
.is-word-card .ezr-translation-actions { margin-top: 14px; }
.is-word-card .ezr-translation-result { font-size: 18px; font-weight: 600; line-height: 1.55; margin-top: 19px; }
.ezr-word-knowledge { margin-top: 10px; }
.ezr-word-knowledge:empty, .ezr-word-credit:empty { display: none; }
.ezr-word-knowledge p { margin: 0; }
.ezr-word-meaning { font-size: 13px; }
.ezr-word-usage { margin-top: 14px; }
.ezr-word-caption { display: block; color: var(--ezr-muted); font-size: 10px; margin-bottom: 4px; }
.ezr-word-example { margin-top: 14px; border-left: 2px solid var(--ezr-accent); padding-left: 11px; }
.ezr-word-example-translation { font-size: 12px; color: var(--ezr-muted); padding-top: 4px; }
.ezr-word-credit { font-size: 10px; color: var(--ezr-muted); margin-top: 12px; }
.ezr-word-credit a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.ezr-word-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; padding-top: 13px; border-top: 1px solid var(--ezr-border); }
.ezr-word-actions[hidden], .ezr-word-actions button[hidden] { display: none !important; }
.ezr-study-bar[hidden], .ezr-word-retry[hidden] { display: none !important; }
.ezr-translation-quick { display: flex; flex-wrap: wrap; gap: 8px 14px; padding-top: 12px; color: var(--ezr-muted); font-size: 11px; }
.ezr-translation-quick label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.ezr-translation-quick input { margin: 0; accent-color: var(--ezr-accent); }
.ezr-study-bar { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.ezr-study-level { flex: 1; min-width: 0; border: 1px solid var(--ezr-border); border-radius: 6px; padding: 5px; font: inherit; color: var(--ezr-fg); background: var(--ezr-bg); }
.ezr-translation .ezr-study-article { font-size: 12px; }
.ezr-vocabulary-heading { color: var(--ezr-muted); font-size: 12px; padding-top: 8px; }
.ezr-vocabulary-word { border-top: 1px solid var(--ezr-border); margin-top: 10px; padding-top: 10px; }
.ezr-vocabulary-word summary { cursor: pointer; font-size: 13px; }
.ezr-vocabulary-word summary span { padding-left: 8px; color: var(--ezr-muted); }
.ezr-vocabulary-word[open] summary { margin-bottom: 8px; }
.ezr-translation .ezr-word-retry { margin-top: 12px; font-size: 12px; }
.ezr-translation .ezr-word-actions button { padding: 5px 9px; font-size: 12px; }
.ezr-translation .ezr-word-save { background: var(--ezr-accent); border-color: var(--ezr-accent); color: var(--ezr-accent-fg); }

/* Free-form translation panel: draggable, so it can be moved off whatever it covers. */
.ezr-text-translation {
  position: fixed; z-index: 2147483642; width: 380px; max-width: calc(100vw - 20px);
  max-height: calc(100vh - 20px); overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px; border: 1px solid var(--ezr-border); border-radius: 12px;
  box-shadow: 0 14px 40px rgba(0,0,0,.22); background: var(--ezr-bg); color: var(--ezr-fg);
  font: 13px/1.6 'Segoe UI', 'Microsoft YaHei', sans-serif; text-align: left; overscroll-behavior: contain;
}
.ezr-text-translation[hidden] { display: none !important; }
.ezr-text-translation > * { flex-shrink: 0; }
.ezr-text-translation.is-dragging, .ezr-text-translation.is-dragging .ezr-text-head { cursor: grabbing; user-select: none; }
.ezr-text-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: -4px -4px 0; padding: 4px; border-radius: 8px; cursor: grab; touch-action: none;
}
.ezr-text-title { font-weight: 600; }
.ezr-text-translation .ezr-text-close {
  flex: none; padding: 0 6px; border: 0; background: none; color: var(--ezr-muted);
  font: 20px/1 sans-serif; cursor: pointer;
}
.ezr-text-translation .ezr-text-close:hover { background: none; color: var(--ezr-fg); }
.ezr-text-controls { display:flex; flex-wrap:wrap; gap:8px; }
.ezr-text-target-field { display:flex; flex:1; align-items:center; gap:6px; white-space:nowrap; }
.ezr-text-field { display: flex; flex-direction: column; gap: 5px; }
.ezr-text-caption { color: var(--ezr-muted); font-size: 11px; }
.ezr-text-translation select, .ezr-text-translation textarea, .ezr-text-translation button {
  border: 1px solid var(--ezr-border); border-radius: 7px;
  background: var(--ezr-bg); color: var(--ezr-fg); font: inherit;
}
.ezr-text-controls select { flex: 1; min-width: 0; padding: 5px 8px; cursor: pointer; }
.ezr-text-translation textarea { padding: 7px 9px; resize: vertical; min-height: 34px; }
.ezr-text-input { min-height: 78px; }
.ezr-text-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ezr-text-translation button { padding: 6px 12px; cursor: pointer; }
.ezr-text-translation button:hover:not(:disabled) { background: color-mix(in srgb, var(--ezr-fg) 7%, var(--ezr-bg)); }
.ezr-text-translation .ezr-text-run {
  border-color: var(--ezr-accent); background: var(--ezr-accent); color: var(--ezr-accent-fg); font-weight: 600;
}
.ezr-text-translation .ezr-text-run:hover:not(:disabled) { background: color-mix(in srgb, var(--ezr-accent) 88%, #000); }
.ezr-text-translation button:disabled { opacity: .5; cursor: not-allowed; }
.ezr-text-translation :focus-visible { outline: 2px solid var(--ezr-accent); outline-offset: 2px; }
.ezr-text-output {
  min-height: 44px; max-height: 240px; overflow-y: auto; padding: 9px 10px;
  border: 1px solid var(--ezr-border); border-radius: 8px;
  background: color-mix(in srgb, var(--ezr-fg) 4%, var(--ezr-bg));
  white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
}
.ezr-text-output:empty::before { content: '译文会显示在这里'; color: var(--ezr-muted); }
.ezr-text-status { min-height: 1em; color: var(--ezr-muted); font-size: 11px; }

.ezr-settings :is(button, select, input):focus-visible { outline: 2px solid var(--ezr-accent); outline-offset: 3px; }
@media (max-width: 420px) {
  .ezr-settings-head { padding: 22px 20px 18px; }
  .ezr-settings-scroll { padding-left: 20px; padding-right: 20px; }
  .ezr-settings-foot { padding: 14px 20px; }
}
@media (prefers-reduced-motion: reduce) {
  .ezr-settings.is-open { animation: none; }
  .ezr-settings .ezr-check::after { transition: none; }
}

@media print { .ezr-toolbar, .ezr-outline { display: none !important } }
@media print { .ezr-text-translation { display: none !important } }

/* The UI adds .ezr-theme-auto to the root when theme === 'auto'. */
@media (prefers-color-scheme: dark) {
  .ezr-theme-auto { --ezr-fg: #e6e6e6; --ezr-bg: #16181c; --ezr-muted: #9aa0a6; --ezr-border: #2c2f36; --ezr-accent: #8cb6f3; --ezr-accent-fg: #12243f; }
}
`;
}

/**
 * Custom property values for one settings object. Every value is a string and
 * every key carries its `--` prefix.
 *
 * `--ezr-gap` always comes from {@link paragraphGapPx} (`bodyFontSize ×
 * lineHeight` is the line height used), and `--ezr-scale` is the manual zoom
 * only — fit modes are handled by the UI.
 *
 * @param {unknown} settings settings object (partial input is normalized)
 * @returns {Record<string, string>} CSS custom properties for the reader root
 */
export function cssVarsFor(settings) {
  const s = normalizeSettings(settings);
  const bodyFontSize = /** @type {number} */ (s.bodyFontSize);
  const lineHeight = /** @type {number} */ (s.lineHeight);
  const gapPx = paragraphGapPx({
    lineHeightPx: bodyFontSize * lineHeight,
    gapFactor: /** @type {number} */ (s.gapFactor),
    gapExtraPx: /** @type {number} */ (s.gapExtraPx),
    gapOverridePx: /** @type {number|null} */ (s.gapOverridePx),
  });
  const palette = THEME_COLORS[/** @type {string} */ (s.theme)] || THEME_COLORS[AUTO_THEME_FALLBACK];
  const scale = s.zoomMode === 'manual' ? /** @type {number} */ (s.zoom) : 1;

  return {
    '--ezr-font': fontStackById(s.fontId),
    '--ezr-size-body': `${bodyFontSize}px`,
    '--ezr-size-h1': `${HEADING_FONT_SIZES[0]}px`,
    '--ezr-size-h2': `${HEADING_FONT_SIZES[1]}px`,
    '--ezr-size-h3': `${HEADING_FONT_SIZES[2]}px`,
    '--ezr-size-h4': `${HEADING_FONT_SIZES[3]}px`,
    '--ezr-size-h5': `${HEADING_FONT_SIZES[4]}px`,
    '--ezr-size-h6': `${HEADING_FONT_SIZES[5]}px`,
    '--ezr-lh': String(lineHeight),
    '--ezr-gap': `${gapPx}px`,
    '--ezr-measure': `${/** @type {number} */ (s.measure)}rem`,
    '--ezr-scale': String(scale),
    '--ezr-fg': palette.fg,
    '--ezr-bg': palette.bg,
    '--ezr-muted': palette.muted,
    '--ezr-border': palette.border,
    '--ezr-accent': palette.accent,
    '--ezr-accent-fg': palette.accentFg,
  };
}
