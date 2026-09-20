/**
 * EZ-Reader options page controller.
 *
 * One settings object, one preview: every control clamps its value through
 * `SETTING_LIMITS` / `clamp`, updates the preview synchronously, and persists to
 * `chrome.storage.local` under `ezr:settings:default` (CONTRACTS.md §14) after a
 * short debounce. External changes (reader toolbar, popup, another tab) are
 * mirrored back into the controls via `chrome.storage.onChanged`.
 *
 * Core imports are used defensively: the work happens inside `init()`, and every
 * imported binding is resolved through a small guarded accessor so a temporarily
 * missing export degrades one readout instead of blanking the page.
 */

import { DEFAULT_SETTINGS, FONT_FAMILIES, HEADING_FONT_SIZES, SETTING_LIMITS, clamp } from '../core/constants.js';
import { paragraphGapPx } from '../core/paragraph-gap.js';
import { fontStackById, normalizeSettings, storageKeyFor } from '../core/settings.js';
import { CSS_VARS, cssVarsFor } from '../core/styles.js';

/* ------------------------------------------------------------------ constants */

/** Debounce for persistence; the preview follows the pointer instantly. */
const PERSIST_DEBOUNCE_MS = 250;

/** How long the 「已保存」 pill stays on screen. */
const SAVED_VISIBLE_MS = 1600;

/** Text used for the 首字母大写 demonstration. */
const CASE_SAMPLE = 'an iPhone at the DNA lab costs 2024 dollars';

/** Tokens that the real implementation skips (URLs and e-mail addresses). */
const SKIP_TOKEN_RE = /(:\/\/|^www\.|@)/i;

/** Words: a letter followed by letters, digits, apostrophes or hyphens. */
const WORD_RE = /\p{L}[\p{L}\p{N}'’-]*/gu;

/** Numeric settings, edited by range inputs. */
const NUMERIC_KEYS = ['bodyFontSize', 'lineHeight', 'gapFactor', 'measure', 'zoom'];

/** Boolean settings, edited by checkboxes. */
const BOOLEAN_KEYS = ['capitalizeFirst', 'splitLines', 'restorePosition', 'rememberPerSite', 'showOutline'];

/** Enumerated settings, edited by selects. */
const ENUM_KEYS = ['fontId', 'zoomMode', 'theme', 'headingMode'];

/* ---------------------------------------------------------------------- state */

const state = {
  /** @type {Record<string, unknown>} */
  settings: fallbackSettings(),
  /** @type {boolean} */
  pending: false,
  /** @type {number} */
  writeTimer: 0,
  /** @type {number} */
  savedTimer: 0,
  /** @type {number} */
  errorTimer: 0,
  /** Timestamp until which local slider edits win over `storage.onChanged` echoes. */
  editingUntil: 0,
};

/** @type {Record<string, HTMLElement | null>} */
const els = {};

/* ------------------------------------------------- defensive core-module layer */

/**
 * Complete settings object, via `normalizeSettings` when available.
 * @param {unknown} raw candidate settings
 * @returns {Record<string, unknown>} complete settings object
 */
function safeNormalize(raw) {
  try {
    if (typeof normalizeSettings === 'function') return normalizeSettings(raw);
  } catch {
    /* 落到本地兜底 */
  }
  return fallbackSettings(raw);
}

/**
 * Shallow merge onto the defaults, used when `normalizeSettings` is unavailable.
 * @param {unknown} [raw] partial settings
 * @returns {Record<string, unknown>} complete settings object
 */
function fallbackSettings(raw) {
  const patch = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return { ...DEFAULT_SETTINGS, ...patch };
}

/**
 * Clamp through the shared helper, with a local fallback.
 * @param {number} value candidate
 * @param {number} min inclusive lower bound
 * @param {number} max inclusive upper bound
 * @returns {number} clamped value
 */
function safeClamp(value, min, max) {
  try {
    if (typeof clamp === 'function') return clamp(value, min, max);
  } catch {
    /* 落到本地兜底 */
  }
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * Inclusive bounds for one numeric setting (`SETTING_LIMITS`, else the bounds
 * already declared on the range input).
 * @param {string} key settings key
 * @param {HTMLInputElement | null} [el] backing range input
 * @returns {{min: number, max: number}} bounds
 */
function limitsFor(key, el) {
  try {
    const entry = SETTING_LIMITS && typeof SETTING_LIMITS === 'object' ? SETTING_LIMITS[key] : null;
    if (entry && Number.isFinite(entry.min) && Number.isFinite(entry.max)) {
      return { min: entry.min, max: entry.max };
    }
  } catch {
    /* 落到 DOM 兜底 */
  }
  const min = el ? Number(el.min) : NaN;
  const max = el ? Number(el.max) : NaN;
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) return { min, max };
  return { min: 0, max: Number.MAX_SAFE_INTEGER };
}

/**
 * CSS font stack for a font id.
 * @param {unknown} id font id
 * @returns {string} CSS font-family stack
 */
function safeFontStack(id) {
  try {
    if (typeof fontStackById === 'function') {
      const stack = fontStackById(id);
      if (typeof stack === 'string' && stack !== '') return stack;
    }
  } catch {
    /* 落到字体表兜底 */
  }
  const families = Array.isArray(FONT_FAMILIES) ? FONT_FAMILIES : [];
  const found = families.find((family) => family && family.id === id) || families[0];
  return found && typeof found.stack === 'string' ? found.stack : 'Georgia, serif';
}

/**
 * Paragraph gap in px, via the shared implementation.
 * @param {Record<string, unknown>} settings settings object
 * @returns {number} gap in px
 */
function safeGapPx(settings) {
  const size = Number(settings.bodyFontSize);
  const ratio = Number(settings.lineHeight);
  const lineHeightPx = Number.isFinite(size) && Number.isFinite(ratio) ? size * ratio : 25.6;
  try {
    if (typeof paragraphGapPx === 'function') {
      const gap = paragraphGapPx({
        lineHeightPx,
        gapFactor: Number(settings.gapFactor),
        gapExtraPx: Number(settings.gapExtraPx),
        gapOverridePx: typeof settings.gapOverridePx === 'number' ? settings.gapOverridePx : null,
      });
      if (Number.isFinite(gap)) return gap;
    }
  } catch {
    /* 落到公式兜底 */
  }
  const factor = Math.max(0, Number(settings.gapFactor) || 0);
  const extra = Math.max(Number(settings.gapExtraPx) || 0, lineHeightPx * 0.05);
  return Math.max(factor * lineHeightPx + extra, 1.5 * lineHeightPx);
}

/**
 * The six computed heading sizes in px. Prefers the shared `--ezr-size-h*`
 * variables; falls back to `HEADING_FONT_SIZES` scaled by the body size.
 * @param {Record<string, unknown>} settings settings object
 * @param {Record<string, string>} vars `--ezr-*` variables
 * @returns {number[]} h1..h6 sizes in px
 */
function headingSizes(settings, vars) {
  const out = [];
  for (let level = 1; level <= 6; level += 1) {
    const fromVars = Number.parseFloat(String(vars[`--ezr-size-h${level}`] || ''));
    if (Number.isFinite(fromVars)) {
      out.push(fromVars);
      continue;
    }
    const base = Array.isArray(HEADING_FONT_SIZES) && Number.isFinite(HEADING_FONT_SIZES[level - 1])
      ? HEADING_FONT_SIZES[level - 1]
      : 16;
    const size = Number(settings.bodyFontSize);
    const scale = Number.isFinite(size) && size > 0 ? size / 16 : 1;
    out.push(Math.round(base * scale * 10) / 10);
  }
  return out;
}

/**
 * `--ezr-*` variables for the preview, via `cssVarsFor` when available.
 * @param {Record<string, unknown>} settings settings object
 * @returns {Record<string, string>} CSS custom properties
 */
function safeCssVars(settings) {
  try {
    if (typeof cssVarsFor === 'function') {
      const vars = cssVarsFor(settings);
      if (vars && typeof vars === 'object') return vars;
    }
  } catch {
    /* 落到最小变量集 */
  }
  const sizes = headingSizes(settings, {});
  return {
    '--ezr-font': safeFontStack(settings.fontId),
    '--ezr-size-body': `${Number(settings.bodyFontSize) || 16}px`,
    '--ezr-size-h1': `${sizes[0]}px`,
    '--ezr-size-h2': `${sizes[1]}px`,
    '--ezr-size-h3': `${sizes[2]}px`,
    '--ezr-size-h4': `${sizes[3]}px`,
    '--ezr-size-h5': `${sizes[4]}px`,
    '--ezr-size-h6': `${sizes[5]}px`,
    '--ezr-lh': String(Number(settings.lineHeight) || 1.6),
    '--ezr-gap': `${safeGapPx(settings).toFixed(2)}px`,
    '--ezr-measure': `${Number(settings.measure) || 44}rem`,
    '--ezr-scale': settings.zoomMode === 'manual' ? String(Number(settings.zoom) || 1) : '1',
  };
}

/**
 * `chrome.storage.local` key of the shared default settings.
 * @returns {string} storage key
 */
function defaultSettingsKey() {
  try {
    if (typeof storageKeyFor === 'function') {
      const key = storageKeyFor('', 'settings');
      if (typeof key === 'string' && key !== '') return key;
    }
  } catch {
    /* 落到字面量 */
  }
  return 'ezr:settings:default';
}

/* ---------------------------------------------------------- local sample (#3) */

/**
 * Demonstration of the 首字母大写 transform: only the first character of each
 * word is upper-cased, the rest of the word is left untouched, and URL / e-mail
 * tokens are skipped entirely. Mirrors `toTitleCase` / `segmentForCapitalize`
 * from src/core/title-case.js without importing it (this is a settings-page
 * sample, not the renderer).
 * @param {string} text source text
 * @returns {string} sample output
 */
function sampleTitleCase(text) {
  return String(text)
    .split(/(\s+)/)
    .map((token) => {
      if (token === '' || /^\s+$/.test(token)) return token;
      if (SKIP_TOKEN_RE.test(token)) return token;
      return token.replace(WORD_RE, (word) => word.slice(0, 1).toUpperCase() + word.slice(1));
    })
    .join('');
}

/* ----------------------------------------------------------- chrome primitives */

/**
 * Read from `chrome.storage.local`, surfacing failures inline.
 * @param {string|string[]} keys keys to read
 * @returns {Promise<Record<string, unknown>>} stored values
 */
function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (bag) => {
        const error = chrome.runtime.lastError;
        if (error) {
          showError(`读取设置失败：${String(error.message || error)}`);
          resolve({});
          return;
        }
        resolve(bag && typeof bag === 'object' ? bag : {});
      });
    } catch (error) {
      showError(`读取设置失败：${String((error && error.message) || error)}`);
      resolve({});
    }
  });
}

/**
 * Write to `chrome.storage.local`.
 * @param {Record<string, unknown>} items key/value pairs
 * @returns {Promise<boolean>} true when the write was accepted
 */
function storageSet(items) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(items, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          showError(`保存设置失败：${String(error.message || error)}`);
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (error) {
      showError(`保存设置失败：${String((error && error.message) || error)}`);
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------------ ui helpers */

/**
 * Look up a control by its settings key.
 * @param {string} key settings key
 * @returns {HTMLElement | null} the control, if present
 */
function controlFor(key) {
  return document.querySelector(`[data-key="${key}"]`);
}

/**
 * Read one control's current value, clamped into its legal range.
 * @param {string} key settings key
 * @returns {unknown} the value to persist
 */
function readControlValue(key) {
  const el = controlFor(key);
  if (!el) return undefined;
  if (BOOLEAN_KEYS.includes(key)) return /** @type {HTMLInputElement} */ (el).checked === true;
  if (NUMERIC_KEYS.includes(key)) {
    const input = /** @type {HTMLInputElement} */ (el);
    const bounds = limitsFor(key, input);
    return safeClamp(Number(input.value), bounds.min, bounds.max);
  }
  const value = /** @type {HTMLSelectElement} */ (el).value;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Transient 「已保存」 pill.
 * @param {string} [text] label to flash
 * @returns {void}
 */
function flashSaved(text = '已保存') {
  const el = els.saved;
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (state.savedTimer) clearTimeout(state.savedTimer);
  state.savedTimer = setTimeout(() => {
    state.savedTimer = 0;
    el.hidden = true;
  }, SAVED_VISIBLE_MS);
}

/**
 * Inline error line, auto-hidden after a while.
 * @param {string} text message
 * @returns {void}
 */
function showError(text) {
  const el = els.error;
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (state.errorTimer) clearTimeout(state.errorTimer);
  state.errorTimer = setTimeout(() => {
    state.errorTimer = 0;
    el.hidden = true;
  }, 8000);
}

/* ------------------------------------------------------------------- rendering */

/**
 * Build the font `<select>` from the shared font table.
 * @returns {void}
 */
function buildFontOptions() {
  const select = /** @type {HTMLSelectElement | null} */ (els.font);
  if (!select) return;
  const families = Array.isArray(FONT_FAMILIES) ? FONT_FAMILIES : [];
  select.replaceChildren();
  for (const family of families) {
    if (!family || typeof family.id !== 'string') continue;
    const option = document.createElement('option');
    option.value = family.id;
    option.textContent = typeof family.label === 'string' ? family.label : family.id;
    select.appendChild(option);
  }
  if (select.options.length === 0) {
    const option = document.createElement('option');
    option.value = String(state.settings.fontId || 'serif-georgia');
    option.textContent = '系统默认字体';
    select.appendChild(option);
  }
}

/**
 * Push settings into every control.
 * @param {Record<string, unknown>} settings complete settings object
 * @returns {void}
 */
function applySettingsToControls(settings) {
  const font = /** @type {HTMLSelectElement | null} */ (els.font);
  if (font && typeof settings.fontId === 'string') {
    const hasOption = Array.from(font.options).some((option) => option.value === settings.fontId);
    if (hasOption && font.value !== settings.fontId) font.value = settings.fontId;
  }

  for (const key of NUMERIC_KEYS) {
    const input = /** @type {HTMLInputElement | null} */ (controlFor(key));
    if (!input) continue;
    const value = Number(settings[key]);
    if (!Number.isFinite(value)) continue;
    const text = String(value);
    if (input.value !== text) input.value = text;
  }

  for (const key of BOOLEAN_KEYS) {
    const input = /** @type {HTMLInputElement | null} */ (controlFor(key));
    if (!input) continue;
    const value = settings[key] === true;
    if (input.checked !== value) input.checked = value;
  }

  for (const key of ['zoomMode', 'theme', 'headingMode']) {
    const select = /** @type {HTMLSelectElement | null} */ (controlFor(key));
    if (!select || typeof settings[key] !== 'string') continue;
    const wanted = String(settings[key]);
    const hasOption = Array.from(select.options).some((option) => option.value === wanted);
    if (hasOption && select.value !== wanted) select.value = wanted;
  }

  if (els.zoomRow) els.zoomRow.hidden = settings.zoomMode !== 'manual';
}

/**
 * Numeric readouts and the case/pixel readouts.
 * @param {Record<string, unknown>} settings settings object
 * @param {Record<string, string>} vars `--ezr-*` variables
 * @returns {void}
 */
function updateReadouts(settings, vars) {
  const size = Number(settings.bodyFontSize) || 16;
  const lineHeight = Number(settings.lineHeight) || 1.6;
  const gapFactor = Number(settings.gapFactor) || 1.6;
  const measure = Number(settings.measure) || 44;
  const zoom = Number(settings.zoom) || 1;
  const gapPx = safeGapPx(settings);

  if (els.outSize) els.outSize.textContent = `${size}px`;
  if (els.outLineHeight) els.outLineHeight.textContent = lineHeight.toFixed(2);
  if (els.outGap) els.outGap.textContent = `${gapFactor.toFixed(2)}（${gapPx.toFixed(1)}px）`;
  if (els.outGapInline) els.outGapInline.textContent = `${gapPx.toFixed(1)}px`;
  if (els.outMeasure) els.outMeasure.textContent = `${measure}rem`;
  if (els.outZoom) els.outZoom.textContent = `${Math.round(zoom * 100)}%`;

  if (els.outFont) {
    const first = safeFontStack(settings.fontId).split(',')[0] || '';
    els.outFont.textContent = first.replace(/["']/g, '').trim();
  }

  if (els.outHeadings) {
    const sizes = headingSizes(settings, vars);
    const labels = sizes.map((value, index) => `H${index + 1} ${Number(value.toFixed(1))}px`);
    const ratio = size > 0 ? sizes[0] / size : 1;
    els.outHeadings.textContent = `${labels.join(' · ')}（H1 ≈ 正文字号 × ${ratio.toFixed(2)}）`;
  }
}

/**
 * Paint the preview box and both live readouts from one settings object.
 * @param {Record<string, unknown>} settings settings object
 * @returns {void}
 */
function paintPreview(settings) {
  const vars = safeCssVars(settings);
  const box = els.preview;
  if (box) {
    const keys = Array.isArray(CSS_VARS) ? CSS_VARS : Object.keys(vars);
    for (const key of keys) {
      const value = vars[key];
      if (value === undefined || value === null) continue;
      try {
        box.style.setProperty(key, String(value));
      } catch {
        /* 单个变量失败不影响其它变量 */
      }
    }
  }
  updateReadouts(settings, vars);
  if (els.caseOutput) els.caseOutput.textContent = sampleTitleCase(CASE_SAMPLE);
}

/**
 * Adopt a settings object: state, controls, preview.
 * @param {unknown} raw settings candidate
 * @returns {void}
 */
function applySettings(raw) {
  state.settings = safeNormalize(raw);
  applySettingsToControls(state.settings);
  paintPreview(state.settings);
}

/* ------------------------------------------------------------------ persistence */

/**
 * Apply a patch locally (instant preview) and schedule the write.
 * @param {Record<string, unknown>} patch changed fields
 * @returns {void}
 */
function commit(patch) {
  const next = safeNormalize({ ...state.settings, ...patch });
  state.settings = next;
  applySettingsToControls(next);
  paintPreview(next);
  schedulePersist();
}

/**
 * Debounced persistence to `ezr:settings:default`.
 * @returns {void}
 */
function schedulePersist() {
  state.pending = true;
  if (state.writeTimer) clearTimeout(state.writeTimer);
  state.writeTimer = setTimeout(() => {
    state.writeTimer = 0;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Write the current settings right now (also used when a drag ends).
 * @returns {Promise<void>} resolves once the write finished
 */
async function persistNow() {
  if (state.writeTimer) {
    clearTimeout(state.writeTimer);
    state.writeTimer = 0;
  }
  if (!state.pending) return;
  state.pending = false;
  const snapshot = safeNormalize(state.settings);
  if (await storageSet({ [defaultSettingsKey()]: snapshot })) flashSaved('已保存');
}

/**
 * Load settings into the page.
 * @returns {Promise<void>} resolves once the controls are up to date
 */
async function loadSettings() {
  const key = defaultSettingsKey();
  const bag = await storageGet(key);
  const stored = bag[key];
  applySettings(safeNormalize(stored === undefined || stored === null ? DEFAULT_SETTINGS : stored));
}

/**
 * Restore defaults after an explicit confirmation.
 * @returns {Promise<void>} resolves once the reset was persisted
 */
async function resetAll() {
  const confirmed =
    typeof globalThis.confirm === 'function'
      ? globalThis.confirm('确定要恢复默认设置吗？这会覆盖当前的全局默认值（按站点保存的覆盖项不受影响）。')
      : true;
  if (!confirmed) return;

  const defaults = safeNormalize(DEFAULT_SETTINGS);
  state.pending = false;
  if (state.writeTimer) {
    clearTimeout(state.writeTimer);
    state.writeTimer = 0;
  }
  applySettings(defaults);
  if (await storageSet({ [defaultSettingsKey()]: defaults })) flashSaved('已恢复默认');
}

/* ---------------------------------------------------------------------- wiring */

/**
 * Wire every control. Ranges preview immediately and persist after a debounce.
 * @returns {void}
 */
function bindControls() {
  for (const key of ENUM_KEYS) {
    const el = controlFor(key);
    if (!el) continue;
    el.addEventListener('change', () => {
      const value = readControlValue(key);
      if (value === undefined) return;
      commit({ [key]: value });
    });
  }

  for (const key of BOOLEAN_KEYS) {
    const el = controlFor(key);
    if (!el) continue;
    el.addEventListener('change', () => {
      commit({ [key]: readControlValue(key) === true });
    });
  }

  for (const key of NUMERIC_KEYS) {
    const el = controlFor(key);
    if (!el) continue;
    el.addEventListener('input', () => {
      state.editingUntil = Date.now() + 900;
      const value = readControlValue(key);
      if (value === undefined) return;
      commit({ [key]: value });
    });
    el.addEventListener('change', () => {
      state.editingUntil = Date.now() + 250;
      void persistNow();
    });
  }
}

/**
 * Mirror settings written elsewhere (reader toolbar, popup, another tab).
 * @returns {void}
 */
function bindStorageSync() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const key = defaultSettingsKey();
      if (!changes || !changes[key]) return;
      if (state.pending || state.writeTimer || Date.now() < state.editingUntil) return; // 本页正在写入，忽略自己的回声
      const value = changes[key].newValue;
      applySettings(safeNormalize(value === undefined || value === null ? DEFAULT_SETTINGS : value));
      flashSaved('已同步');
    });
  } catch {
    /* 同步失败不影响手动操作 */
  }
}

/* ------------------------------------------------------------------------ boot */

/**
 * Cache element handles.
 * @returns {void}
 */
function collectElements() {
  els.saved = document.getElementById('saved');
  els.error = document.getElementById('error');
  els.preview = document.getElementById('preview');
  els.font = document.getElementById('set-font');
  els.zoomRow = document.getElementById('zoom-row');
  els.outFont = document.getElementById('out-font');
  els.outSize = document.getElementById('out-size');
  els.outLineHeight = document.getElementById('out-line-height');
  els.outGap = document.getElementById('out-gap');
  els.outGapInline = document.getElementById('out-gap-inline');
  els.outMeasure = document.getElementById('out-measure');
  els.outZoom = document.getElementById('out-zoom');
  els.outHeadings = document.getElementById('out-headings');
  els.caseOutput = document.getElementById('case-output');
  els.reset = document.getElementById('reset');
}

/**
 * Options page entry point.
 * @returns {Promise<void>} resolves once the initial state is on screen
 */
async function init() {
  collectElements();
  buildFontOptions();
  bindControls();
  bindStorageSync();

  applySettings(state.settings);
  render();

  els.reset?.addEventListener('click', () => {
    void resetAll();
  });

  await loadSettings();
}

/**
 * Static bits that only need to exist once.
 * @returns {void}
 */
function render() {
  if (els.caseOutput) els.caseOutput.textContent = sampleTitleCase(CASE_SAMPLE);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void init();
  });
} else {
  void init();
}
