import { TRANSLATION_KEY, ENGLISH_LEVELS, sampleContext, normalizeTranslation } from '../translation/config.js';
import { collectTranslationGroups, applyTranslationGroup, restoreTranslationGroups, isTranslatedSelection } from '../dom/translation-text.js';
import { prioritizeWebsiteGroups } from '../dom/translation-order.js';
import { createTranslation } from './translation.js';
import { createTranslationNotes } from './translation-notes.js';

const CSS = `
.ezr-full-bar { flex:none; display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:10px 18px; border-bottom:1px solid var(--ezr-border); background:var(--ezr-bg); color:var(--ezr-fg); font:13px/1.5 system-ui; }
.ezr-full-bar[hidden],.ezr-full-bar [hidden],.ezr-translation-note[hidden]{display:none!important}
.ezr-full-bar button,.ezr-translation-note button {font:inherit; color:inherit; background:transparent; border:1px solid var(--ezr-border); border-radius:7px; padding:5px 9px; cursor:pointer}
.ezr-full-bar select {font:inherit;color:inherit;background:var(--ezr-bg);border:1px solid var(--ezr-border);border-radius:7px;padding:5px 9px}
.ezr-full-bar :is(button,select,input):focus-visible,.ezr-translation-note button:focus-visible {outline:2px solid var(--ezr-accent);outline-offset:2px}
.ezr-full-start {background:var(--ezr-accent)!important;color:var(--ezr-accent-fg)!important;border-color:transparent!important}
.ezr-full-bar label {display:flex;align-items:center;gap:5px;white-space:nowrap}
.ezr-full-status{color:var(--ezr-muted);font-size:12px; flex:1;min-width:160px}
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
  let bar, status, start, stop, bilingualInput, originalSelection, originalRoot, levelInput, cardsInput, providerInput;
  let reader = null, website = [], readerGroups = [], notes = null, view = null;
  let enabled = false, bilingual = true, running = false, epoch = 0, revision = 0, url = doc.location.href, signature = '';
  let visible = false, originalSuspended = false, selectionPrefs = normalizeTranslation();
  let navigationTimer = 0;
  let activeProvider = selectionPrefs.provider;
  const cache = new Map();
  const make = (tag, cls, text) => { const element = doc.createElement(tag); element.className = cls; if (text) element.textContent = text; return element; };
  const cacheKey = (text, provider = activeProvider) => JSON.stringify([provider, text]);
  const message = text => { if (status) status.textContent = text; };
  const closeSelections = () => { originalSelection?.close(); reader?.closeSelection(); };
  function ensureUI() {
    if (bar || !reader) return;
    if (!navigationTimer) navigationTimer = setInterval(checkUrl, 750);
    bar = make('div', 'ezr-full-bar'); bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '全文翻译'); bar.hidden = true;
    start = make('button', 'ezr-full-start', '全文翻译'); stop = make('button', 'ezr-full-stop', '停止'); stop.hidden = true;
    providerInput = make('select', 'ezr-full-provider'); providerInput.setAttribute('aria-label', '全文翻译服务');
    for (const [value, label] of [['free', '免费翻译'], ['deepseek', 'DeepSeek']]) { const option = make('option', '', label); option.value = value; providerInput.appendChild(option); }
    providerInput.value = selectionPrefs.provider;
    const restore = make('button', 'ezr-full-restore', '显示原文');
    const bilingualLabel = make('label', ''); bilingualInput = make('input', 'ezr-full-bilingual'); bilingualInput.type = 'checkbox'; bilingualInput.checked = true; bilingualLabel.append(bilingualInput, doc.createTextNode('双语对照'));
    const cardsLabel = make('label', ''); cardsInput = make('input', 'ezr-full-cards'); cardsInput.type = 'checkbox'; cardsInput.checked = selectionPrefs.wordCards; cardsLabel.append(cardsInput, doc.createTextNode('划词生词卡'));
    levelInput = make('select', 'ezr-full-level'); levelInput.setAttribute('aria-label', '生词卡英语水平');
    for (const [value, label] of ENGLISH_LEVELS) { const option = make('option', '', label); option.value = value; levelInput.appendChild(option); }
    levelInput.value = selectionPrefs.level;
    const settings = make('button', 'ezr-full-settings', '翻译设置'), close = make('button', 'ezr-full-close', '×'); close.setAttribute('aria-label', '收起全文翻译工具');
    status = make('span', 'ezr-full-status', '免费翻译无需密钥，有每日额度；DeepSeek 需配置 Key。'); status.setAttribute('aria-live', 'polite');
    bar.append(providerInput, start, stop, restore, bilingualLabel, cardsLabel, levelInput, settings, close, status);
    for (const button of bar.querySelectorAll('button')) button.type = 'button';
    start.addEventListener('click', () => { void translate(); });
    stop.addEventListener('click', () => { epoch++; running = false; sync(); message('已停止；已完成的译文保留，可继续翻译。'); });
    restore.addEventListener('click', () => { epoch++; running = false; enabled = false; closeSelections(); restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); notes?.clear(); sync(); message('已显示原文，可划词翻译；再次全文翻译会复用已有结果。'); });
    bilingualInput.addEventListener('change', () => { closeSelections(); bilingual = bilingualInput.checked; apply(readerGroups, true); notes?.clear(); });
    async function preferences(patch) {
      try {
        const result = await request({ type: 'ezr:translation:preferences', patch });
        if (!result?.ok) throw new Error(result?.message || '设置保存失败。');
        selectionPrefs = normalizeTranslation(result.config); notes?.clear(); sync();
      } catch (error) { message(error.message); sync(); }
    }
    cardsInput.addEventListener('change', () => { void preferences({ wordCards: cardsInput.checked }); });
    levelInput.addEventListener('change', () => { void preferences({ level: levelInput.value }); });
    providerInput.addEventListener('change', () => { void preferences({ provider: providerInput.value }); });
    settings.addEventListener('click', () => { void request({ type: 'ezr:translation:options' }); });
    close.addEventListener('click', () => { visible = false; bar.hidden = true; });
    originalRoot = make('div', 'ezr-original-selection'); reader.root.appendChild(originalRoot);
    originalSelection = createTranslation({ root: originalRoot, article: doc.body, doc, request, mode: 'original',
      isActive: () => !!reader && !isReaderActive() && !originalSuspended, canSelect: range => !isTranslatedSelection(range, website), getView: () => view,
      getDocument: () => ({ title: doc.title, blocks: [{ text: view?.context || sampleContext(doc.body.innerText) }] }) });
    void request({ type: 'ezr:translation:config' }).then(result => { if (result?.ok) { selectionPrefs = normalizeTranslation(result.config); sync(); } }).catch(() => {});
    place();
  }
  function sync() { if (!bar) return; providerInput.value = selectionPrefs.provider; start.disabled = running; start.textContent = enabled && cache.size ? '继续翻译' : '全文翻译'; stop.hidden = !running; bilingualInput.checked = bilingual; bilingualInput.parentElement.hidden = !isReaderActive(); cardsInput.parentElement.hidden = levelInput.hidden = !isReaderActive(); cardsInput.checked = selectionPrefs.wordCards; levelInput.value = selectionPrefs.level; }
  function place() {
    if (!bar || !reader) return;
    reader.root.insertBefore(bar, reader.article.parentElement);
    bar.hidden = !visible; sync();
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
    ensureUI(); checkUrl(); if (running) return;
    closeSelections();
    running = true; const token = ++epoch, version = revision, requestUrl = url; sync();
    try {
      const reply = await request({ type: 'ezr:translation:config' });
      if (token !== epoch) return;
      if (!reply?.ok) throw new Error(reply?.message || '无法读取翻译设置。');
      const provider = reply.config.provider;
      if (provider === 'deepseek' && !reply.hasKey) throw new Error('请填写 DeepSeek API Key，或切换到免费翻译。');
      activeProvider = provider;
      const nextSignature = JSON.stringify([reply.config.source, reply.config.target, reply.config.model]);
      if (signature && signature !== nextSignature) { invalidate(); signature = nextSignature; void translate(); return; }
      signature = nextSignature; selectionPrefs = normalizeTranslation(reply.config);
      restoreTranslationGroups(website); website = collectTranslationGroups(doc.body, doc);
      if (!isReaderActive()) website = prioritizeWebsiteGroups(website, doc);
      if (!view) view = { id: crypto.randomUUID(), title: doc.title, language: doc.documentElement.lang, fullDocument: true,
        context: sampleContext(website.map(group => group.source).join('\n\n')) };
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
    const nextSignature = JSON.stringify([next.source, next.target, next.model]);
    if (signature && signature !== nextSignature) { invalidate(); signature = nextSignature; }
    if (activeProvider !== next.provider) {
      epoch++; running = false; enabled = false;
      // Valid selections contain only source text, which restoring translations does not change.
      // Keep them alive when the provider is changed from the selection popup itself.
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
    show() { if (!reader) return; ensureUI(); visible = true; place(); }, translate,
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
