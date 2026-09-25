import { TRANSLATION_KEY, LANGUAGES, ENGLISH_LEVELS, sampleContext, normalizeTranslation } from '../translation/config.js';
import { collectTranslationGroups, applyTranslationGroup, restoreTranslationGroups, isTranslatedSelection } from '../dom/translation-text.js';
import { prioritizeWebsiteGroups } from '../dom/translation-order.js';
import { createTranslation } from './translation.js';
import { createTranslationNotes } from './translation-notes.js';
import { closeIcon } from './close-icon.js';

const CSS = `
.ezr-full-bar { flex:none; display:grid; grid-template-columns:var(--ezr-toolbar-title-width, clamp(120px, 15vw, 210px)) minmax(0,1fr) 32px; align-items:start; gap:4px 12px; padding:10px 16px; border-bottom:1px solid var(--ezr-border); background:var(--ezr-bg); color:var(--ezr-fg); font:13px/1.4 'Segoe UI','Microsoft YaHei',sans-serif; }
.ezr-full-bar[hidden],.ezr-full-bar [hidden],.ezr-translation-note[hidden]{display:none!important}
.ezr-full-caption { display:flex; align-items:center; min-height:30px; color:var(--ezr-muted); }
.ezr-full-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-width:0; }
.ezr-full-bar button,.ezr-full-bar select { min-height:30px; font:inherit; color:inherit; background:var(--ezr-bg); border:1px solid var(--ezr-border); border-radius:7px; padding:4px 9px; cursor:pointer; }
.ezr-full-bar button:hover,.ezr-full-bar select:hover { background:color-mix(in srgb,var(--ezr-fg) 6%,var(--ezr-bg)); }
.ezr-full-bar :is(button,select,input):focus-visible,.ezr-translation-note button:focus-visible { outline:2px solid var(--ezr-accent);outline-offset:2px; }
.ezr-full-bar .ezr-full-start[aria-pressed="false"] {background:var(--ezr-accent);color:var(--ezr-accent-fg);border-color:var(--ezr-accent);}
.ezr-full-bar label {display:flex;align-items:center;gap:6px;white-space:nowrap;min-height:30px;}
.ezr-full-bar input[type="checkbox"] { accent-color:var(--ezr-accent); }
.ezr-full-status{grid-column:2; color:var(--ezr-muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere;}
.ezr-full-status:empty {display:none;}
.ezr-full-selection-toggle {padding:0 4px;}
.ezr-full-bar .ezr-toolbar-close {grid-column:3;grid-row:1;}
@media(max-width:760px) { .ezr-full-bar {grid-template-columns:minmax(0,1fr) 32px;} .ezr-full-caption{display:none;} .ezr-full-bar .ezr-toolbar-close{grid-column:2;} .ezr-full-status{grid-column:1;} }
.ezr-translation-note button {font:inherit; color:inherit; background:transparent; border:1px solid var(--ezr-border); border-radius:7px; padding:5px 9px; cursor:pointer;}
.ezr-full-target{display:block; margin-top:.65em; padding-top:.5em; border-top:1px solid var(--ezr-border);color:var(--ezr-fg);font-size:.94em;line-height:1.75;text-transform:none}
.ezr-translation-notes{position:fixed;inset:0;pointer-events:none;z-index:25}
.ezr-translation-note{position:fixed;max-height:228px;overflow:auto;box-sizing:border-box;pointer-events:auto;background:var(--ezr-bg);color:var(--ezr-fg);border:1px solid var(--ezr-border);border-left:3px solid var(--ezr-accent);border-radius:9px;padding:12px;box-shadow:0 5px 18px #0000000d;font:12px/1.55 system-ui;overflow-wrap:anywhere}
.ezr-note-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:15px}.ezr-note-head button{border:0;padding:0 4px}
.ezr-translation-note p{margin:7px 0}.ezr-note-translation{font-size:14px}.ezr-translation-note small{display:block;margin-top:8px;color:var(--ezr-muted)}.ezr-note-actions{display:flex;gap:6px;margin-top:10px}
@media(min-width:1100px){.ezr-body.ezr-has-notes{margin-inline:220px}}
:host([data-ezr-original]) .ezr-translation-notes {display:none}
.ezr-original-selection {display:none}
:host([data-ezr-original]) .ezr-original-selection {display:contents}
`;

/** A document owns the translation cache, shared by website and all reader re-renders. */
export function createFullTranslation({ doc = document, request = message => chrome.runtime.sendMessage(message), isReaderActive = () => false }) {
  let bar, status, start, stop, bilingualInput, originalSelection, originalRoot, levelInput, cardsInput, providerInput, selectionInput, targetInput, readerTools;
  let reader = null, website = [], readerGroups = [], notes = null, view = null;
  let enabled = false, bilingual = true, running = false, epoch = 0, revision = 0, url = doc.location.href, signature = '';
  let visible = false, originalSuspended = false, selectionPrefs = normalizeTranslation();
  let navigationTimer = 0, savingPreferences = false;
  let activeProvider = selectionPrefs.provider;
  const cache = new Map();
  const make = (tag, cls, text) => { const element = doc.createElement(tag); element.className = cls; if (text) element.textContent = text; return element; };
  const cacheKey = (text, provider = activeProvider) => JSON.stringify([provider, text]);
  const message = text => { if (status) status.textContent = text; };
  const closeSelections = () => { originalSelection?.close(); reader?.closeSelection(); };
  function ensureUI() {
    if (bar || !reader) return;
    if (!navigationTimer) navigationTimer = setInterval(checkUrl, 750);
    bar = make('div', 'ezr-full-bar'); bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '翻译工具栏'); bar.id = 'ezr-translation-bar'; bar.hidden = true;
    start = make('button', 'ezr-full-start', '全文翻译'); stop = make('button', 'ezr-full-stop', '停止'); stop.hidden = true;
    providerInput = make('select', 'ezr-full-provider'); providerInput.setAttribute('aria-label', '全文翻译服务');
    for (const [value, label] of [['free', '免费翻译'], ['deepseek', 'DeepSeek']]) { const option = make('option', '', label); option.value = value; providerInput.appendChild(option); }
    providerInput.value = selectionPrefs.provider;
    const targetLabel = make('label', 'ezr-full-target-language');
    targetLabel.appendChild(doc.createTextNode('译为'));
    targetInput = make('select', 'ezr-full-target-select');
    targetInput.setAttribute('aria-label', '全文和划词翻译目标语言');
    targetInput.title = '全文翻译与划词翻译共用';
    for (const [value, text] of LANGUAGES) { const option = make('option', '', text); option.value = value; targetInput.appendChild(option); }
    targetLabel.appendChild(targetInput);
    const inputText = make('button', 'ezr-full-input', '输入文字');
    inputText.title = '输入或粘贴文字翻译';
    const selectionLabel = make('label', 'ezr-full-selection-toggle');
    selectionInput = make('input', 'ezr-full-selection'); selectionInput.type = 'checkbox';
    selectionLabel.append(selectionInput, doc.createTextNode('划词翻译'));
    selectionLabel.title = '开启后，选中文字自动显示翻译浮窗';
    const bilingualLabel = make('label', ''); bilingualInput = make('input', 'ezr-full-bilingual'); bilingualInput.type = 'checkbox'; bilingualInput.checked = true; bilingualLabel.append(bilingualInput, doc.createTextNode('双语对照'));
    const cardsLabel = make('label', ''); cardsInput = make('input', 'ezr-full-cards'); cardsInput.type = 'checkbox'; cardsInput.checked = selectionPrefs.wordCards; cardsLabel.append(cardsInput, doc.createTextNode('划词生词卡'));
    levelInput = make('select', 'ezr-full-level'); levelInput.setAttribute('aria-label', '生词卡英语水平');
    for (const [value, label] of ENGLISH_LEVELS) { const option = make('option', '', label); option.value = value; levelInput.appendChild(option); }
    levelInput.value = selectionPrefs.level;
    const settings = make('button', 'ezr-full-settings', '翻译设置'), close = make('button', 'ezr-full-close ezr-toolbar-close', ''); close.setAttribute('aria-label', '关闭翻译工具栏'); close.title = '关闭翻译工具栏'; close.appendChild(closeIcon(doc));
    status = make('span', 'ezr-full-status', ''); status.setAttribute('aria-live', 'polite');
    readerTools = make('button', 'ezr-full-reader-tools', '阅读工具');
    readerTools.title = '重新显示主工具栏';
    readerTools.addEventListener('click', () => reader?.showMainToolbar?.());
    const caption = make('span', 'ezr-full-caption', '翻译');
    const controls = make('div', 'ezr-full-controls');
    controls.append(providerInput, targetLabel, start, stop, inputText, selectionLabel, bilingualLabel, cardsLabel, levelInput, settings, readerTools);
    bar.append(caption, controls, close, status);
    for (const button of bar.querySelectorAll('button')) button.type = 'button';
    start.addEventListener('click', () => { if (enabled || running) showOriginal(); else void translate(); });
    inputText.addEventListener('click', () => { reader?.openTextTranslation?.(); });
    selectionInput.addEventListener('change', () => { void preferences({ enabled:selectionInput.checked }); });
    stop.addEventListener('click', () => { epoch++; running = false; sync(); message('已停止，已完成的译文保留。可切回原文后继续翻译。'); });
    bilingualInput.addEventListener('change', () => { closeSelections(); bilingual = bilingualInput.checked; apply(readerGroups, true); notes?.clear(); });
    async function preferences(patch) {
      if (savingPreferences) return;
      savingPreferences = true;
      const before = selectionPrefs;
      if (Object.hasOwn(patch, 'target') && patch.target !== before.target) invalidate();
      selectionPrefs = normalizeTranslation({ ...before, ...patch }); sync();
      try {
        const result = await request({ type: 'ezr:translation:preferences', patch });
        if (!result?.ok) throw new Error(result?.message || '设置保存失败。');
        selectionPrefs = normalizeTranslation(result.config); notes?.clear(); sync();
      } catch (error) { selectionPrefs = before; message(error.message); }
      finally { savingPreferences = false; sync(); }
    }
    cardsInput.addEventListener('change', () => { void preferences({ wordCards: cardsInput.checked }); });
    levelInput.addEventListener('change', () => { void preferences({ level: levelInput.value }); });
    providerInput.addEventListener('change', () => { void preferences({ provider: providerInput.value }); });
    targetInput.addEventListener('change', () => { void preferences({ target:targetInput.value }); });
    settings.addEventListener('click', () => { void request({ type: 'ezr:translation:options' }); });
    close.addEventListener('click', () => { visible = false; bar.hidden = true; reader?.onTranslationVisibility?.(false); });
    originalRoot = make('div', 'ezr-original-selection'); reader.root.appendChild(originalRoot);
    originalSelection = createTranslation({ root: originalRoot, article: doc.body, doc, request, mode: 'original',
      isActive: () => !!reader && !isReaderActive() && !originalSuspended, getView: () => view,
      getDocument: () => ({ title: doc.title, blocks: [] }) });
    void request({ type: 'ezr:translation:config' }).then(result => { if (result?.ok) { selectionPrefs = normalizeTranslation(result.config); sync(); } }).catch(() => {});
    place();
  }
  function showOriginal() {
    epoch++; running = false; enabled = false; closeSelections();
    restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); notes?.clear();
    if (reader?.showOriginal) reader.showOriginal();
    sync(); message('已显示原文，再次翻译会复用已有结果。');
  }
  function sync() {
    if (!bar) return;
    providerInput.value = selectionPrefs.provider;
    targetInput.value = selectionPrefs.target;
    readerTools.hidden = reader?.isMainToolbarVisible?.() !== false;
    for (const input of [providerInput, targetInput, selectionInput, cardsInput, levelInput]) input.disabled = savingPreferences;
    start.disabled = savingPreferences; start.textContent = enabled || running ? '显示原文' : '全文翻译';
    start.setAttribute('aria-pressed', String(enabled || running));
    stop.hidden = !running;
    selectionInput.checked = selectionPrefs.enabled;
    bilingualInput.checked = bilingual; bilingualInput.parentElement.hidden = !isReaderActive();
    cardsInput.parentElement.hidden = levelInput.hidden = !isReaderActive() || !selectionPrefs.enabled;
    cardsInput.checked = selectionPrefs.wordCards; levelInput.value = selectionPrefs.level;
  }
  function place() {
    if (!bar || !reader) return;
    const host = reader.toolbarHost;
    if (host) host.appendChild(bar);
    else reader.root.insertBefore(bar, reader.article.parentElement);
    bar.hidden = !visible; reader?.onTranslationVisibility?.(visible); sync();
  }
  function apply(groups, inReader) {
    if (!enabled || !reader || (!inReader && (originalSuspended || isReaderActive()))) return;
    for (const group of groups) {
      const results = group.chunks.map(chunk => cache.get(cacheKey(chunk)));
      const mode = inReader && bilingual;
      if (group.appliedResults?.every((item, index) => item === results[index]) && group.appliedMode === mode) continue;
      if (results.every(Boolean)) {
        closeSelections();
        if (applyTranslationGroup(group, results, mode)) { group.appliedResults = results; group.appliedMode = mode; }
      }
    }
  }
  function invalidate() {
    epoch++; revision++; running = false; enabled = false;
    restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); website = []; readerGroups = [];
    cache.clear(); view = null; notes?.clear(); closeSelections();
    sync(); if (status) status.textContent = '页面或翻译设置已改变，请重新开始。';
  }
  function checkUrl() { if (url !== doc.location.href) { invalidate(); url = doc.location.href; } }
  function collectReader() {
    const blocks = reader.getDocument().blocks;
    return collectTranslationGroups(reader.article, doc).filter(group => {
      const owner = group.block.closest('[data-ezr-id]');
      const path = blocks[Number(owner?.dataset.ezrId)]?.srcPath;
      if (!path) return true;
      try {
        const source = doc.querySelector(path);
        return !source?.closest('[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,input,textarea,select,button');
      } catch { return true; }
    });
  }
  async function translate() {
    if (!reader) return;
    ensureUI(); checkUrl(); if (running || savingPreferences) return;
    closeSelections();
    running = true; const token = ++epoch, version = revision, requestUrl = url; sync();
    try {
      if (reader.prepareTranslation) await reader.prepareTranslation();
      if (token !== epoch) { if (!enabled) reader?.showOriginal?.(); return; }
      const reply = await request({ type: 'ezr:translation:config' });
      if (token !== epoch) return;
      if (!reply?.ok) throw new Error(reply?.message || '无法读取翻译设置。');
      const provider = reply.config.provider;
      if (provider === 'deepseek' && !reply.hasKey) throw new Error('请填写 DeepSeek API Key，或切换到免费翻译。');
      activeProvider = provider;
      const nextSignature = JSON.stringify([reply.config.source, reply.config.target, reply.config.model, reply.config.stylePrompt]);
      if (signature && signature !== nextSignature) { invalidate(); signature = nextSignature; void translate(); return; }
      signature = nextSignature; selectionPrefs = normalizeTranslation(reply.config);
      restoreTranslationGroups(website); website = reader.isPdf ? [] : collectTranslationGroups(doc.body, doc);
      if (!isReaderActive()) website = prioritizeWebsiteGroups(website, doc);
      if (!view) view = { id: crypto.randomUUID(), title: doc.title, language: doc.documentElement.lang, fullDocument: true,
        context: sampleContext(isReaderActive() ? reader.getDocument().blocks.map(block => block.text || '').join('\n\n') : website.map(group => group.source).join('\n\n')) };
      if (reader) { restoreTranslationGroups(readerGroups); readerGroups = collectReader(); }
      const groups = isReaderActive() ? readerGroups : website;
      const texts = [...new Set(groups.flatMap(group => group.chunks))];
      if (!texts.length) throw new Error('当前视图没有可翻译的文字。');
      enabled = true; apply(website, false); apply(readerGroups, true);
      const pending = texts.filter(text => !cache.has(cacheKey(text)));
      let completed = texts.length - pending.length;
      while (pending.length && token === epoch && doc.location.href === url) {
        const batch = []; let length = 0;
        // One text run per message: stopping must not leave a queue of paid requests in the worker.
        while (pending.length && batch.length < 1 && length + pending[0].length <= 2000) { const text = pending.shift(); batch.push(text); length += text.length; }
        message(`翻译中 ${completed}/${texts.length} · ${provider === 'free' ? 'MyMemory 免费翻译' : 'DeepSeek'} · 可随时停止`);
        const result = await request({ type: 'ezr:translation:full', provider, texts: batch, view });
        // Keep successful late results for resume, but never apply an obsolete page/config.
        if (doc.location.href !== requestUrl || revision !== version || signature !== nextSignature) return;
        if (!result?.ok) throw new Error(result?.message || '全文翻译失败，请重试。');
        result.results.forEach(item => cache.set(cacheKey(item.source, provider), item));
        if (token !== epoch) return;
        completed += result.results.length; apply(website, false); apply(readerGroups, true);
        if (result.error) throw new Error(`${result.error} 已完成 ${completed}/${texts.length}，重试会复用已完成内容。`);
      }
      if (token === epoch) message(`已翻译 ${completed}/${texts.length} · ${provider === 'free' ? 'MyMemory' : 'DeepSeek'} · 切换视图复用结果`);
    } catch (error) { if (token === epoch) message(error.message || '全文翻译失败，请重试。'); }
    finally { if (token === epoch) { running = false; sync(); } }
  }
  const storageChanged = (changes, area) => {
    if (area !== 'local' || !changes[TRANSLATION_KEY]) return;
    const next = normalizeTranslation(changes[TRANSLATION_KEY].newValue);
    const nextSignature = JSON.stringify([next.source, next.target, next.model, next.stylePrompt]);
    if (signature && signature !== nextSignature) { invalidate(); signature = nextSignature; }
    if (activeProvider !== next.provider) {
      epoch++; running = false; enabled = false;
      // Provider changes keep the captured selection text; restoring the view does not rewrite that snapshot.
      restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); notes?.clear();
      activeProvider = next.provider;
      if (status) status.textContent = '翻译服务已切换，点击全文翻译；已有结果会保留在缓存中。';
    }
    if (!next.wordCards || !next.enabled || next.level !== selectionPrefs.level || next.explanations !== selectionPrefs.explanations) notes?.clear();
    selectionPrefs = next; sync();
  };
  chrome.storage.onChanged.addListener(storageChanged);
  // SPA navigation must also invalidate a stopped or fully translated view.
  doc.defaultView.addEventListener?.('pagehide', () => { clearInterval(navigationTimer); chrome.storage.onChanged.removeListener(storageChanged); }, { once: true });
  return {
    show() { if (!reader) return; ensureUI(); visible = true; place(); },
    toggle() { if (!reader) return; ensureUI(); visible = !visible; place(); }, translate,
    mainToolbarChanged() { sync(); },
    getView() { checkUrl(); return view; },
    isTranslatedSelection(range) { checkUrl(); return isTranslatedSelection(range, readerGroups); },
    addCards(cards, range) { return enabled && selectionPrefs.wordCards && selectionPrefs.enabled && notes ? notes.add(cards, range) : false; },
    beforeRead() { originalSuspended = true; closeSelections(); restoreTranslationGroups(website); },
    afterRead() { originalSuspended = false; if (enabled) apply(website, false); sync(); },
    readerPaint() { notes?.clear(); if (reader && enabled) { readerGroups = collectReader(); apply(readerGroups, true); } },
    bindReader(value) {
      reader = value; const style = make('style', 'ezr-full-style'); style.textContent = CSS; reader.root.appendChild(style);
      notes = createTranslationNotes({ ...value, doc, request });
      readerGroups = enabled ? collectReader() : []; ensureUI(); apply(readerGroups, true); place();
    },
    unbindReader() {
      epoch++; running = false; enabled = false; visible = false; closeSelections();
      restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); readerGroups = [];
      notes?.destroy(); notes = null; originalSelection?.destroy(); originalSelection = null;
      originalRoot?.remove(); originalRoot = null; bar?.remove(); bar = null; status = null; reader = null;
    },
    previewChanged() {
      closeSelections();
      if (reader?.isPdf && !isReaderActive()) { epoch++; running = false; enabled = false; restoreTranslationGroups(readerGroups); notes?.clear(); }
      if (isReaderActive()) {
        restoreTranslationGroups(website);
        if (enabled) { restoreTranslationGroups(readerGroups); readerGroups = collectReader(); apply(readerGroups, true); }
      }
      else apply(website, false);
      place();
    },
    get isSelectionOpen() { return !!originalSelection?.isOpen; },
    closeSelection() { originalSelection?.close(); },
    get state() { return { enabled, running, bilingual, cached: cache.size }; },
  };
}
