/**
 * EZ-Reader content script entry.
 *
 * Bundled by tools/build.js into one IIFE that runs in every frame
 * (`all_frames: true`). Responsibilities:
 *   - the lifecycle of at most one reader session per document,
 *   - a reading overlay that leaves the source subtree in its original location,
 *   - settings persistence, reading-position save/restore,
 *   - the message protocol used by the popup and the background worker.
 *
 * Compilation lives in src/dom, rendering in src/core/render.js, chrome in src/ui.
 * Deliberately depends only on the interfaces written down in CONTRACTS.md.
 * Re-running this bundle in the same document is a no-op.
 */

import { DEFAULT_SETTINGS, FONT_FAMILIES, HEADING_FONT_SIZES, MAX_BLOCKS, SETTING_LIMITS } from './core/constants.js';
import { blocksToOutline, renderDoc } from './core/render.js';
import { fontStackById, isCjkDominant, normalizeSettings, resolveSettings, storageKeyFor } from './core/settings.js';
import { buildDocFromElement, findBestRoot, resolveRoot, textStats } from './dom/extract.js';
import { scanDocument } from './dom/scan.js';
import { createOriginalCapitalization } from './dom/original-capitalization.js';
import { applyVars, mount } from './ui/mount.js';
import { createOutline } from './ui/outline.js';
import { createPicker } from './ui/picker.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { createToast } from './ui/toast.js';
import { createToolbar } from './ui/toolbar.js';
import { createZoomWatcher } from './ui/zoom.js';
import { createTranslation } from './ui/translation.js';
import { createTextTranslation } from './ui/text-input-translation.js';
import { createFullTranslation } from './ui/full-translation.js';
import { createFrameSelection } from './ui/frame-selection.js';
import { findDocumentSources } from './dom/document-sources.js';

const GUARD = '__EZR_CONTENT_LOADED__';
if (!globalThis[GUARD]) {
  globalThis[GUARD] = true;
  bootstrap();
}

function bootstrap() {
  const doc = globalThis.document;
  if (!doc || !doc.documentElement) return;

  const isTopFrame = globalThis.top === globalThis;
  const isDocumentReader = typeof chrome !== 'undefined' && doc.location.href.split(/[?#]/)[0] === chrome.runtime.getURL('pages/document-reader.html');
  globalThis.__ezrDocumentSources = () => findDocumentSources(doc);
  const frameSelection = !isTopFrame ? createFrameSelection(doc) : null;
  const hasStorage = typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;

  /** @type {null | object} */
  let session = null;
  let pdfDocument = null;
  let activePicker = null;
  let pickerOverlay = null;
  let restoreAfterPick = null;
  let busy = false;
  let lifecycle = 0, windowRevision = -1, toolbarWindowId = null, windowClosing = false, windowManaged = false;
  const fullTranslation = createFullTranslation({ doc, isReaderActive: () => !!session && !session.previewing });
  const originalCapitalization = createOriginalCapitalization(doc);

  /* -------------------------------------------------------------- persistence */

  const storage = {
    async read(key) {
      if (!hasStorage) return undefined;
      const bag = await chrome.storage.local.get(key);
      return bag ? bag[key] : undefined;
    },
    async write(key, value) {
      if (!hasStorage) return;
      await chrome.storage.local.set({ [key]: value });
    },
  };

  const origin = (() => {
    try {
      const { origin: o, protocol } = globalThis.location;
      return o && o !== 'null' ? o : protocol;
    } catch {
      return 'unknown';
    }
  })();

  /**
   * Read (and, when necessary, seed) the persisted settings for a settings store.
   * Called with the store as `this`.
   */
  async function readPersisted() {
    const [storedDefaults, storedByOrigin] = await Promise.all([
      storage.read(storageKeyFor('', 'settings')),
      storage.read('ezr:settings:byOrigin'),
    ]);
    // Seeded on install by the background worker; this is the safety net for the case
    // where the worker never ran (e.g. the bundle was injected by hand).
    if (!storedDefaults) {
      const seeded = { ...DEFAULT_SETTINGS };
      void storage.write(storageKeyFor('', 'settings'), seeded);
      this.defaults = seeded;
    } else {
      this.defaults = normalizeSettings({ ...DEFAULT_SETTINGS, ...storedDefaults });
    }
    this.byOrigin = storedByOrigin || {};
  }

  const settingsStore = {
    /** The user's global settings. */
    defaults: { ...DEFAULT_SETTINGS },
    /** Per-origin overrides, keyed by origin. */
    byOrigin: {},
    /** What the reader actually renders. */
    resolved: { ...DEFAULT_SETTINGS },

    async load() {
      await readPersisted.call(this);
      this.resolved = normalizeSettings(resolveSettings(this.defaults, this.byOrigin, origin));
      return this.resolved;
    },

    get() {
      return this.resolved;
    },

    /** The subset of `resolved` that this origin has explicitly overridden. */
    originSettings() {
      if (!this.resolved.rememberPerSite) return {};
      return { ...(this.byOrigin[origin] || {}) };
    },

    /**
     * Apply a settings patch, persist it, and re-render the live session.
     *
     * The patch is always merged onto `resolved` (what the user sees) and never onto a
     * partial per-origin record, so a half-filled record can never zero out fields the
     * user did not touch.
     *
     * @param {object} patch partial settings
     * @param {{transient?: boolean}} [options] transient = live drag, skip persistence
     */
    async update(patch, options = {}) {
      const next = normalizeSettings({ ...this.resolved, ...patch });
      this.resolved = next;
      if (session) session.applySettings(next);
      if (options.transient) return next;

      if (next.rememberPerSite) {
        this.byOrigin[origin] = { ...(this.byOrigin[origin] || {}), ...patch };
        await storage.write('ezr:settings:byOrigin', this.byOrigin);
      } else {
        this.defaults = next;
        await storage.write(storageKeyFor('', 'settings'), next);
      }
      return next;
    },

    /**
     * 保存工具栏停靠边。
     *
     * 停靠边属于工具栏自身属性，而非网站显示偏好，故固定写入共享默认值，
     * 对所有站点生效，不受 `rememberPerSite` 影响。
     * @param {'top'|'bottom'} dock 目标停靠边。
     * @returns {Promise<Record<string, unknown>>} 更新后的生效设置。
     */
    async setToolbarDock(dock) {
      const next = normalizeSettings({ ...this.resolved, toolbarDock: dock });
      this.resolved = next;
      this.defaults = normalizeSettings({ ...this.defaults, toolbarDock: next.toolbarDock });
      if (session) session.applySettings(next);
      await storage.write(storageKeyFor('', 'settings'), this.defaults);
      return next;
    },

    async reset() {
      this.defaults = { ...DEFAULT_SETTINGS };
      this.byOrigin = { ...this.byOrigin, [origin]: {} };
      this.resolved = { ...DEFAULT_SETTINGS };
      await Promise.all([
        storage.write(storageKeyFor('', 'settings'), this.defaults),
        storage.write('ezr:settings:byOrigin', this.byOrigin),
      ]);
      if (session) session.applySettings(this.resolved);
      return this.resolved;
    },

    async savePosition(entry) {
      const all = (await storage.read('ezr:pos')) || {};
      all[globalThis.location.href] = entry;
      const keys = Object.keys(all);
      if (keys.length > 300) {
        keys
          .sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0))
          .slice(0, keys.length - 300)
          .forEach((k) => delete all[k]);
      }
      await storage.write('ezr:pos', all);
    },

    async loadPosition() {
      const all = (await storage.read('ezr:pos')) || {};
      return all[globalThis.location.href] || null;
    },
  };

  /* ------------------------------------------------------------------- toasts */

  /**
   * Standalone toast, usable before a session exists. Kept self-contained so it
   * renders correctly even if the reader chrome is not mounted yet.
   * @param {string} message
   * @param {'info'|'warn'|'error'} [kind]
   */
  function transientToast(message, kind = 'info') {
    try {
      const host = doc.createElement('div');
      host.setAttribute('data-ezr-toast', '');
      const shadow = host.attachShadow({ mode: 'open' });
      const style = doc.createElement('style');
      const palette =
        kind === 'error'
          ? { bg: '#fdecec', fg: '#7f1d1d', border: '#f3b6b6' }
          : kind === 'warn'
            ? { bg: '#fffbe6', fg: '#5c4813', border: '#f0d98a' }
            : { bg: '#eef6ff', fg: '#123a63', border: '#b7d5f2' };
      style.textContent =
        ':host{all:initial}div{position:fixed;left:50%;top:24px;transform:translateX(-50%);' +
        'max-width:min(600px,90vw);padding:10px 16px;border-radius:10px;z-index:2147483647;' +
        'font:14px/1.6 "Segoe UI",Roboto,"Microsoft YaHei",sans-serif;text-align:left;' +
        `box-shadow:0 6px 24px rgba(0,0,0,.18);background:${palette.bg};color:${palette.fg};` +
        `border:1px solid ${palette.border}}`;
      const box = doc.createElement('div');
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      box.textContent = String(message);
      shadow.append(style, box);
      doc.documentElement.appendChild(host);
      globalThis.setTimeout(() => host.remove(), 4200);
    } catch {
      /* a notification must never break the host page */
    }
  }

  function notify(message, kind) {
    if (session && session.toast) session.toast.show(message, kind);
    else transientToast(message, kind);
  }

  /* ------------------------------------------------------------------ session */

  /**
   * @param {object} irDoc
   * @param {object} settings resolved settings (what is rendered)
   */
  function createSession(irDoc, settings, original = false) {
    // Keep the source DOM, styles and event handlers in place, including on re-selection.
    const shell = mount({ doc, settings, onClose: () => close() });
    // `mount()` exposes the outline as `outlineHost` (an <aside class="ezr-outline">);
    // the reader chrome keeps the SHORT name so the handler code below stays readable.
    shell.outline = shell.outlineHost;
    /** The actual scroll container inside the shadow root. */
    const scroller = shell.root.querySelector('.ezr-body') || shell.root;
    const toast = createToast(shell.toastHost, {});

    let currentDoc = irDoc;
    let destroyed = false;
    let previewing = original;
    const documentUrl = doc.location.href;
    shell.host.toggleAttribute('data-ezr-original', previewing);
    let readingScrollTop = 0;

    const zoomState = { scale: 1 };

    const outline = createOutline(shell.outlineHost, {
      settings,
      onJump: (blockId) => jumpToBlock(blockId),
    });

    const settingsPanel = createSettingsPanel(shell.root, {
      settings,
      previewing,
      originSettings: settingsStore.originSettings(),
      onChange: (patch) => {
        settingsStore.update(patch);
      },
      onReset: () => {
        if (previewing) settingsStore.update({ theme: DEFAULT_SETTINGS.theme, capitalizeFirst: DEFAULT_SETTINGS.capitalizeFirst, rememberPerSite: DEFAULT_SETTINGS.rememberPerSite });
        else settingsStore.reset();
      },
    });

    const abort = new AbortController();
    const translation = createTranslation({ root: shell.root, article: shell.article, getDocument: () => currentDoc, doc,
      getView: () => fullTranslation.getView(),
      onCards: (cards, range) => fullTranslation.addCards(cards, range) });

    // Free-form translation works in both views: it never depends on the article.
    const textTranslation = createTextTranslation({ root: shell.root, doc });

    const zoom = createZoomWatcher({
      doc,
      element: shell.article,
      getSettings: () => settingsStore.get(),
      measure: () => measureNaturalWidth(shell.article),
      onChange: (value) => {
        zoomState.scale = value;
        shell.root.style.setProperty('--ezr-scale', String(value));
        toolbar.setZoom(value);
      },
    });

    const toolbar = createToolbar(shell.toolbarHost, {
      settings,
      isPdf:isDocumentReader,
      // A per-origin record may only contain a few keys; the toolbar needs the
      // resolved values, and the settings panel needs the origin's own overrides so
      // its controls show "default" for fields this site never changed.
      originSettings: settingsStore.originSettings(),
      onToggleOutline: () => {
        // `outline.setOpen` owns both the panel class and the host's visibility; reading
        // the state from either one keeps this from double-toggling.
        const current = typeof outline.isOpen === 'boolean' ? outline.isOpen : !shell.outline.hidden;
        outline.setOpen(!current);
      },
      onPickRegion: () => startPick(),
      onToggleCapitalize: () => {
        const next = !settingsStore.get().capitalizeFirst;
        settingsStore.update({ capitalizeFirst: next });
        if (next && cjkDominant(currentDoc)) {
          notify('本页以中日韩文字为主，「首字母大写」对中文没有效果。', 'warn');
        }
      },
      onFit: () => settingsStore.update({ zoomMode: 'fit-width' }),
      onZoom: (delta) => {
        const next = Math.min(2.5, Math.max(0.6, Number(((zoomState.scale || 1) + delta * 0.1).toFixed(2))));
        settingsStore.update({ zoomMode: 'manual', zoom: next });
      },
      onOpenOriginal: () => setPreviewing(!previewing),
      onFullTranslation: () => fullTranslation.toggle(),
      onOpenSettings: () => {
        translation.close();
        fullTranslation.closeSelection();
        settingsPanel.toggle();
      },
      onClose: () => closeWindowTools(),
      onFontQuick: (fontId) => settingsStore.update({ fontId }),
      onToggleDock: (dock) => { void settingsStore.setToolbarDock(dock); },
    });

    function paint(nextDoc, nextSettings) {
      translation.close();
      // renderDoc supplies an article wrapper for standalone use. mount already
      // owns that wrapper; nesting it would apply zoom and padding twice.
      const rendered = renderDoc(nextDoc, nextSettings, { doc }).firstChild;
      shell.article.replaceChildren(...rendered.childNodes);
      outline.render(blocksToOutline(nextDoc));
      fullTranslation.readerPaint();
    }

    function jumpToBlock(blockId) {
      const target = shell.article.querySelector(`[data-ezr-id="${Number(blockId)}"]`);
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function setPreviewing(value) {
      if (destroyed || previewing === !!value) return;
      if (!value && !currentDoc.blocks.length) { void open().catch(error => notify(error.message, 'warn')); return; }
      if (value) {
        translation.close();
        savePosition();
        readingScrollTop = scroller.scrollTop;
        settingsPanel.close();
      }
      previewing = !!value;
      shell.host.toggleAttribute('data-ezr-original', previewing);
      toolbar.setPreviewing(previewing);
      settingsPanel.setPreviewing(previewing);
      originalCapitalization.setEnabled(!isDocumentReader && (previewing && settingsStore.get().capitalizeFirst));
      fullTranslation.previewChanged();
      if (!previewing) {
        scroller.scrollTop = readingScrollTop;
        zoom.recalc();
      }
    }

    function savePosition() {
      if (destroyed || previewing) return;
      const entry = {
        scrollY: scroller ? scroller.scrollTop : 0,
        blockId: firstVisibleBlockId(),
        srcPath: currentDoc.srcPath || null,
        ts: Date.now(),
      };
      void settingsStore.savePosition(entry);
    }

    function firstVisibleBlockId() {
      const viewportTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const children = shell.article.children;
      for (let i = 0; i < children.length; i += 1) {
        if (children[i].getBoundingClientRect().bottom > viewportTop + 8) {
          const raw = children[i].getAttribute('data-ezr-id');
          return raw === null ? i : Number(raw);
        }
      }
      return 0;
    }

    async function restorePosition() {
      const settingsNow = settingsStore.get();
      if (!settingsNow.restorePosition) return;
      const entry = await settingsStore.loadPosition();
      if (!entry || destroyed || previewing) return;
      if (entry.blockId !== undefined && entry.blockId !== null) {
        const target = shell.article.querySelector(`[data-ezr-id="${Number(entry.blockId)}"]`);
        if (target) {
          target.scrollIntoView({ block: 'start', behavior: 'instant' });
          return;
        }
      }
      if (typeof entry.scrollY === 'number' && scroller) scroller.scrollTop = entry.scrollY;
    }

    paint(currentDoc, settings);
    toolbar.setPreviewing(previewing);
    originalCapitalization.setEnabled(!isDocumentReader && (previewing && settings.capitalizeFirst));
    fullTranslation.bindReader({ root: shell.root, toolbarHost:shell.toolbarHost, isPdf:isDocumentReader, article: shell.article, getDocument: () => currentDoc, closeSelection: () => translation.close(),
      openTextTranslation: () => { translation.close(); fullTranslation.closeSelection(); settingsPanel.close(); textTranslation.toggle(); },
      onTranslationVisibility: value => toolbar.setTranslationOpen(value),
      isMainToolbarVisible: () => !toolbar.element.hidden,
      showMainToolbar: () => { toolbar.element.hidden = false; fullTranslation.mainToolbarChanged(); },
      prepareTranslation: isDocumentReader ? async () => { if (!currentDoc.blocks.length) { const result = await open(); if (!result?.ok) throw new Error('PDF 文字尚未准备好，请稍后重试。'); } else setPreviewing(false); } : null,
      showOriginal: isDocumentReader ? () => setPreviewing(true) : null });
    outline.setOpen(!!settings.showOutline);
    shell.outline.classList.toggle('is-open', !!settings.showOutline);

    let scrollSaveTimer = 0;
    scroller.addEventListener(
      'scroll',
      () => {
        if (scrollSaveTimer || destroyed) return;
        scrollSaveTimer = globalThis.setTimeout(() => {
          scrollSaveTimer = 0;
          savePosition();
        }, 600);
      },
      { passive: true, signal: abort.signal },
    );

    doc.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;
        if (activePicker) return; // the picker owns Escape while it is active
        if (translation.isOpen || fullTranslation.isSelectionOpen) {
          event.preventDefault();
          event.stopPropagation();
          translation.close();
          fullTranslation.closeSelection();
          return;
        }
        if (settingsPanel.isOpen) {
          event.preventDefault();
          event.stopPropagation();
          settingsPanel.close();
          return;
        }
        if (textTranslation.isOpen) {
          event.preventDefault();
          event.stopPropagation();
          textTranslation.close();
          return;
        }
        event.stopPropagation();
        if (!previewing) setPreviewing(true);
      },
      { capture: true, signal: abort.signal },
    );

    zoom.recalc();
    void restorePosition();

    return {
      shell,
      toast,
      scroller,
      hideMainToolbar() { toolbar.element.hidden = true; settingsPanel.close(); fullTranslation.mainToolbarChanged(); },
      showMainToolbar() { toolbar.element.hidden = false; fullTranslation.mainToolbarChanged(); },
      setPreviewing,
      get documentUrl() { return documentUrl; },
      get hasDocument() { return currentDoc.blocks.length > 0; },
      translateText(text) { textTranslation.openText(text, true, true); },
      get previewing() { return previewing; },
      /** @param {object} nextSettings */
      applySettings(nextSettings) {
        applyVars(shell.root, nextSettings);
        shell.setDock(nextSettings.toolbarDock);
        // applyVars seeds automatic zoom at 1. Preserve the measured scale while
        // recalculating: the watcher suppresses callbacks for unchanged results.
        shell.root.style.setProperty('--ezr-scale', String(zoomState.scale));
        toolbar.update(nextSettings);
        toolbar.setZoom(zoomState.scale);
        settingsPanel.update(nextSettings);
        originalCapitalization.setEnabled(!isDocumentReader && (previewing && !activePicker && nextSettings.capitalizeFirst));
        paint(currentDoc, nextSettings);
        zoom.recalc();
      },
      /** Re-select a different source region without leaving the reader. */
      reload(nextRoot, preparedDoc) {
        const nextDoc = preparedDoc || buildDocFromElement(nextRoot, { doc, settings: settingsStore.get() });
        if (!nextDoc) return false;
        currentDoc = nextDoc;
        translation.reset();
        readingScrollTop = 0;
        paint(currentDoc, settingsStore.get());
        zoom.recalc();
        return true;
      },
      savePosition,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        globalThis.clearTimeout(scrollSaveTimer);
        abort.abort();
        translation.destroy();
        fullTranslation.unbindReader();
        settingsPanel.destroy();
        textTranslation.destroy();
        toolbar.destroy();
        outline.destroy();
        toast.destroy();
        zoom.destroy();

        shell.destroy();
      },
    };
  }

  /* -------------------------------------------------------------------- zoom */

  function measureNaturalWidth(article) {
    // max-width resolves --ezr-measure (including rem) to CSS pixels independently
    // of the current zoom or the width imposed by the surrounding layout.
    const width = parseFloat(doc.defaultView.getComputedStyle(article).maxWidth);
    return Number.isFinite(width) && width > 0 ? width : article.clientWidth;
  }

  /* ----------------------------------------------------------------- picking */

  function startPick() {
    if (isDocumentReader) return { ok:false, reason:'pdf-view', message:'PDF 请直接选择文字翻译，或使用全文翻译。' };
    if (session && !session.previewing) return { ok: false, reason: 'wrong-view', message: '请先切换到原网页，再选择区域。' };
    if (activePicker) {
      endPick();
      return { ok: true, picking: false };
    }

    fullTranslation.beforeRead();
    originalCapitalization.setEnabled(false);
    const previousSession = session;
    const wasPreviewing = previousSession?.previewing || false;
    if (previousSession) {
      previousSession.setPreviewing(true);
      // Detach the complete overlay: page CSS cannot make it reappear over the
      // control the user wants to select. Its shadow tree and session stay alive.
      previousSession.shell.host.remove();
      restoreAfterPick = () => {
        if (session !== previousSession) return;
        doc.documentElement.appendChild(previousSession.shell.host);
        previousSession.setPreviewing(wasPreviewing);
      };
    }

    const host = doc.createElement('div');
    host.setAttribute('data-ezr-pick-overlay', '');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = ':host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important}';
    shadow.appendChild(style);
    const hint = doc.createElement('div');
    hint.textContent = '点击要阅读的区域；Esc 或右键取消。';
    hint.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:10px 16px;background:#172033;color:white;border-radius:8px;font:14px/1.6 system-ui;z-index:2147483647;pointer-events:none';
    shadow.appendChild(hint);
    doc.documentElement.appendChild(host);
    pickerOverlay = host;

    activePicker = createPicker({
      doc,
      overlayHost: shadow,
      onPick: (element) => {
        const nextDoc = buildDocFromElement(element, { doc, settings: settingsStore.get(), minTextChars: 1 });
        if (!nextDoc) {
          hint.textContent = '这个区域没有可读文字，请换一个区域；Esc 取消。';
          activePicker.start();
          return;
        }
        endPick();
        if (session) {
          session.reload(element, nextDoc);
          session.setPreviewing(false);
          session.scroller.scrollTop = 0;
        } else {
          session = createSession(nextDoc, settingsStore.get());
        }
      },
      onCancel: () => endPick(),
    });
    activePicker.start();
    return { ok: true, picking: true };
  }

  function endPick() {
    const picker = activePicker;
    activePicker = null;
    if (picker) picker.destroy();
    if (pickerOverlay) pickerOverlay.remove();
    pickerOverlay = null;
    const restore = restoreAfterPick;
    restoreAfterPick = null;
    if (restore) restore();
    fullTranslation.afterRead();
    originalCapitalization.setEnabled(!isDocumentReader && (session?.previewing && settingsStore.get().capitalizeFirst));
  }

  /* -------------------------------------------------------------- open/close */

  async function open(options = {}) {
    if (busy) return { ok: false, reason: 'busy' };
    endPick();
    if (session?.hasDocument && session.documentUrl === doc.location.href) {
      session.setPreviewing(false);
      return { ok: true, already: true };
    }
    busy = true;
    const generation = ++lifecycle;
    fullTranslation.beforeRead();
    originalCapitalization.setEnabled(false);
    try {
      const settings = options.settings
        ? normalizeSettings({ ...DEFAULT_SETTINGS, ...options.settings })
        : await settingsStore.load();
      settingsStore.resolved = settings;
      if (generation !== lifecycle) return { ok: false, reason: 'cancelled' };

      let root = null;
      let irDoc = null;
      if (isDocumentReader) {
        if (!pdfDocument) await globalThis.__ezrPreparePdf?.();
        if (!pdfDocument) throw new Error('PDF 尚未准备好，请先打开 PDF。');
        root = doc.body; irDoc = pdfDocument;
      }

      // Reuse the region this site was last read with, when it still exists.
      if (!irDoc && options.srcPath) {
        root = resolveRoot({ doc, srcPath: options.srcPath, selection: null });
        if (root) irDoc = buildDocFromElement(root, { doc, settings, minTextChars:isDocumentReader ? 1 : undefined });
      }
      if (!irDoc) {
        // Keep the source element alongside its IR for re-selection.
        try {
          root = findBestRoot({ doc, settings });
        } catch {
          root = doc.body || doc.documentElement || null;
        }
        if (root) {
          try {
            irDoc = buildDocFromElement(root, { doc, settings });
          } catch {
            irDoc = null;
          }
        }
      }
      if (!irDoc || !root) {
        transientToast('没能在这个页面上找到可阅读的正文，请点「选区」按钮手动选择区域。', 'warn');
        return { ok: false, reason: 'empty' };
      }

      if (generation !== lifecycle) return { ok:false, reason:'cancelled' };
      if (session) { session.reload(root, irDoc); session.setPreviewing(false); }
      else session = createSession(irDoc, settings);
      const stats = textStats(irDoc);
      if (irDoc.truncated) {
        notify(`内容很长，只转换了前 ${MAX_BLOCKS} 个段落。`, 'warn');
      }
      if (settings.capitalizeFirst && stats.cjkRatio > 0.3) {
        notify('本页以中日韩文字为主，「首字母大写」对中文没有效果。', 'warn');
      }
      return { ok: true, blocks: irDoc.blocks.length, chars: stats.chars };
    } finally {
      busy = false;
      fullTranslation.afterRead();
      originalCapitalization.setEnabled(!isDocumentReader && (session?.previewing && settingsStore.get().capitalizeFirst));
    }
  }

  function close() {
    lifecycle++;
    endPick();
    originalCapitalization.setEnabled(false);
    const current = session;
    if (!current) return { ok: false, reason: 'not-open' };
    session = null;
    current.savePosition();
    current.destroy();
    return { ok: true };
  }

  async function showToolbar(revealMain = true) {
    if (session && session.documentUrl !== doc.location.href) close();
    if (session) { if (revealMain) session.showMainToolbar(); return { ok: true, already: true }; }
    const generation = ++lifecycle;
    const settings = await settingsStore.load();
    if (generation !== lifecycle) return { ok: false, reason: 'cancelled' };
    session = createSession({ title: doc.title, blocks: [], srcPath: null }, settings, true);
    return { ok: true };
  }

  async function applyToolbarState(state) {
    if (!state.configured) return { ok: true };
    if (toolbarWindowId !== state.windowId) { windowRevision = -1; toolbarWindowId = state.windowId; windowClosing = false; }
    if (state.revision < windowRevision || (windowClosing && state.revision <= windowRevision)) return { ok: true, stale: true };
    const revealMain = state.revision > windowRevision;
    windowRevision = state.revision; windowClosing = false;
    if (state.enabled) { windowManaged = true; return showToolbar(revealMain); }
    // Window synchronization owns only sessions it opened, not local automation/debug sessions.
    if (windowManaged) close();
    windowManaged = false; return { ok: true };
  }

  function closeWindowTools() {
    // This closes the main toolbar only. The reader and translation tools keep
    // their sessions; window synchronization must also keep frame selection alive.
    session?.hideMainToolbar();
  }

  function cjkDominant(irDoc) {
    try {
      return isCjkDominant(irDoc.blocks.map((b) => b.text || '').join(' '));
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- messaging */

  /**
   * Single dispatcher shared by the runtime message listener and the debug helper,
   * so automated tests exercise exactly the code path the popup uses.
   *
   * Frames that are not the top frame only acknowledge broadcast commands; the top
   * frame owns the reader. `ezr:status` is special-cased because every frame answers
   * it — with `all_frames: true` we cannot know which frame replies first, so callers
   * treat a `topFrame: false` answer as "ask again", not as "idle".
   *
   * @param {string} type
   * @param {{patch?: object, options?: object, type?: string}} [message]
   */
  async function handleMessage(type, message = {}) {
    switch (type) {
      case 'ezr:frame-toolbar-state':
        frameSelection?.setEnabled(message.enabled, message.revision, message.windowId);
        return { ok:true, topFrame:isTopFrame };
      case 'ezr:toolbar-state':
        return isTopFrame ? applyToolbarState(message) : { ok: true, topFrame: false };
      case 'ezr:toolbar-open':
        return isTopFrame ? showToolbar() : { ok: true, topFrame: false };
      case 'ezr:status':
        return {
          ok: true,
          topFrame: isTopFrame,
          active: !!session,
          picking: !!activePicker,
          previewing: !!session?.previewing,
          blocks: session ? session.shell.article.children.length : 0,
          settings: settingsStore.get(),
          url: globalThis.location.href,
          fontStack: fontStackById(settingsStore.get().fontId),
        };
      case 'ezr:get-settings':
        return { ok: true, settings: await settingsStore.load() };
      case 'ezr:close': {
        const wasOpen = !!session;
        close();
        return { ok: true, topFrame: isTopFrame, closed: wasOpen };
      }
      default:
        break;
    }

    if (!isTopFrame) return { ok: true, topFrame: false, active: false, ack: type };

    switch (type) {
      case 'ezr:translate-selection':
        if (!isDocumentReader) return { ok:false, reason:'document-reader-only' };
        if (!session) await showToolbar();
        session.translateText(String(message.text || ''));
        return { ok:true };
      case 'ezr:toggle':
        return session ? close() : open(message.options || {});
      case 'ezr:open':
        return open(message.options || {});
      case 'ezr:pick':
        if (busy) return { ok: false, reason: 'busy' };
        if (!session) await showToolbar();
        return startPick();
      case 'ezr:full-translation':
        if (!session) {
          const result = await open();
          if (!result.ok) return { ...result, message: '未找到可阅读正文，请先用“选择区域”打开阅读器，再使用翻译。' };
        }
        fullTranslation.show();
        return { ok: true, ...fullTranslation.state };
      case 'ezr:update-settings':
        await settingsStore.load();
        return { ok: true, settings: await settingsStore.update(message.patch || {}) };
      case 'ezr:reset-settings':
        await settingsStore.load();
        return { ok: true, settings: await settingsStore.reset() };
      case 'ezr:reload': {
        // Re-read persisted settings; used after the popup wrote to storage directly
        // because the reader was closed at the time. Safe when already open.
        const reloaded = await settingsStore.load();
        if (session) session.applySettings(reloaded);
        return { ok: true, settings: reloaded };
      }
      default:
        return { ok: false, reason: 'unknown-message', type };
    }
  }

  if (!isDocumentReader && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const type = message && message.type;
      // Only reply to our own namespaced messages, and never swallow another
      // extension's traffic: returning `undefined` leaves their channel intact.
      if (typeof type !== 'string' || !type.startsWith('ezr:')) return undefined;

      handleMessage(type, message)
        .then((response) => sendResponse(response))
        .catch((error) =>
          sendResponse({ ok: false, reason: 'error', message: String((error && error.message) || error) }),
        );

      return true; // async reply
    });
  }

  // Debug/automation surface. Content scripts share an isolated world with the page
  // but not its JS heap, so this cannot be reached by page scripts.
  globalThis.__ezr = {
    open,
    close,
    setPdfDocument(parsed) {
      if (!isDocumentReader) return { ok:false };
      if (!parsed) { pdfDocument = null; return { ok:true }; }
      if (!Array.isArray(parsed.pages) || parsed.pages.length > 1000) throw new Error('PDF 页数超过限制。');
      const blocks = []; let chars = 0;
      for (const [index, page] of parsed.pages.entries()) {
        const text = String(page.text || ''); chars += text.length;
        if (chars > 2_000_000) throw new Error('PDF 文字超过限制，请拆分文件。');
        blocks.push({ type:'heading', level:2, text:String(page.title || '第 ' + (index + 1) + ' 页') });
        if (text.trim()) blocks.push({ type:'para', text, lines:text.split(/\r?\n/) });
      }
      pdfDocument = { title:String(parsed.title || doc.title), blocks, srcPath:null, truncated:false };
      return { ok:true };
    },
    toggle: () => (session ? close() : open({})),
    pick: () => handleMessage('ezr:pick'),
    send: (message) => handleMessage(message && message.type, message || {}),
    status: () => ({
      active: !!session,
      topFrame: isTopFrame,
      blocks: session ? session.shell.article.children.length : 0,
      settings: settingsStore.get(),
      fontStack: fontStackById(settingsStore.get().fontId),
    }),
    /**
     * Inspect the extraction pipeline without opening the reader.
     *
     * A silent "empty" result can come from root selection, from scanning, or from the
     * classifier, and the browser reports none of those. Each stage is therefore
     * reported separately so a failure is attributable.
     *
     * @param {string} [srcPath] optional explicit root selector
     */
    probe: (srcPath) => {
      const settings = settingsStore.get();
      let element = null;
      try {
        if (srcPath) element = resolveRoot({ doc, srcPath, selection: null });
      } catch (error) {
        return { stage: 'resolve', error: String(error && error.message) };
      }
      if (!element) {
        try {
          element = findBestRoot({ doc, settings });
        } catch (error) {
          return { stage: 'findBestRoot', error: String((error && error.stack) || error) };
        }
      }
      if (!element) return { stage: 'findBestRoot', element: null, reason: 'no candidate element' };

      const describe = {
        tag: element.tagName,
        id: element.id || null,
        className: typeof element.className === 'string' ? element.className.slice(0, 80) : null,
        childCount: element.children ? element.children.length : 0,
        textLength: (element.textContent || '').length,
      };

      try {
        const scoped = scanDocument(element, { doc, maxBlocks: 500 });
        const built = buildDocFromElement(element, { doc, settings });
        return {
          stage: 'done',
          element: describe,
          scanned: scoped.blocks.length,
          blocks: built ? built.blocks.length : 0,
          truncated: scoped.truncated,
          body: scoped.body,
          firstTypes: scoped.blocks.slice(0, 5).map((b) => `${b.type}:${String(b.text || '').slice(0, 22)}`),
          stats: built ? textStats(built) : null,
        };
      } catch (error) {
        return { stage: 'scan', element: describe, error: String((error && error.stack) || error) };
      }
    },
  };

  // Alias used by tools/browser-test.js: one dispatcher, two entry names.
  globalThis.__ezrSend = globalThis.__ezr.send;

  /**
   * Constants for automation. Exposed here rather than loaded by the test through
   * `chrome.runtime.getURL` + dynamic `import()`, because content-script resources are
   * not web-accessible by default and adding them to the manifest just for a test would
   * widen the extension's attack surface. These are plain values already in this bundle.
   */
  globalThis.__ezrConst = {
    defaults: { ...DEFAULT_SETTINGS },
    fonts: FONT_FAMILIES.map((f) => ({ id: f.id, label: f.label, stack: f.stack })),
    limits: SETTING_LIMITS,
    headingSizes: [...HEADING_FONT_SIZES],
  };

  if (!isTopFrame) void settingsStore.load();
  else if (!isDocumentReader && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    const generation = lifecycle;
    void chrome.runtime.sendMessage({ type: 'ezr:window-toolbar:get' }).then(state => {
      if (state?.ok && generation === lifecycle) return applyToolbarState(state);
    }).catch(() => {});
  }
}
