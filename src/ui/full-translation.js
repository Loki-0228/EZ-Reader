import { TRANSLATION_KEY, LANGUAGES, ENGLISH_LEVELS, sampleContext, normalizeTranslation } from '../translation/config.js';
import { collectTranslationGroups, applyTranslationGroup, restoreTranslationGroups, isTranslatedSelection, splitTranslationText, joinTranslations } from '../dom/translation-text.js';
import { prioritizeWebsiteGroups } from '../dom/translation-order.js';
import { createTranslation } from './translation.js';
import { createTranslationNotes } from './translation-notes.js';
import { createBubbleCards, bubbleKey } from './bubble-cards.js';
import { createTranslationMode } from '../translation/mode-control.js';
import { closeIcon } from './close-icon.js';
import { dockIcon } from './dock-icon.js';

const CSS = `
.ezr-full-bar { flex:none; display:grid; grid-template-columns:var(--ezr-toolbar-title-width, clamp(120px, 15vw, 210px)) minmax(0,1fr) auto; align-items:start; gap:.308em .923em; padding:.769em 1.231em; border-bottom:1px solid var(--ezr-border); background:var(--ezr-bg); color:var(--ezr-fg); font:var(--ezr-tool-size,13px)/1.4 'Segoe UI','Microsoft YaHei',sans-serif; }
.ezr-full-bar[hidden],.ezr-full-bar [hidden],.ezr-translation-note[hidden]{display:none!important}
.ezr-full-caption { display:flex; align-items:center; min-height:2.308em; color:var(--ezr-muted); }
.ezr-full-controls { display:flex; align-items:center; flex-wrap:wrap; gap:.615em; min-width:0; }
.ezr-full-bar button,.ezr-full-bar select { min-height:2.308em; font:inherit; color:inherit; background:var(--ezr-bg); border:1px solid var(--ezr-border); border-radius:7px; padding:.308em .692em; cursor:pointer; }
.ezr-full-bar button:disabled {opacity:.55;cursor:default;}
.ezr-full-bar button:hover,.ezr-full-bar select:hover { background:color-mix(in srgb,var(--ezr-fg) 6%,var(--ezr-bg)); }
.ezr-full-bar :is(button,select,input):focus-visible,.ezr-translation-note button:focus-visible { outline:2px solid var(--ezr-accent);outline-offset:2px; }
.ezr-full-bar .ezr-full-start[aria-pressed="false"] {background:var(--ezr-accent);color:var(--ezr-accent-fg);border-color:var(--ezr-accent);}
.ezr-full-bar label {display:flex;align-items:center;gap:.462em;white-space:nowrap;min-height:2.308em;}
.ezr-full-bar input[type="checkbox"] { accent-color:var(--ezr-accent); width:1em;height:1em;font:inherit; }
.ezr-full-status{grid-column:2; color:var(--ezr-muted);font-size:.923em;line-height:1.5;overflow-wrap:anywhere;}
.ezr-full-status:empty {display:none;}
.ezr-full-end {grid-column:3;grid-row:1;}
.ezr-full-controls > * {max-width:100%;}
.ezr-full-target-language {min-width:0;}
.ezr-full-target-select {min-width:0;max-width:100%;}
.ezr-full-preferences{display:flex;align-items:center;gap:.615em;margin-inline-start:auto;flex-wrap:wrap;justify-content:flex-end}
.ezr-full-bar .ezr-full-settings{min-width:5.6em;white-space:nowrap}
@media(max-width:760px) { .ezr-full-bar {grid-template-columns:minmax(0,1fr) auto;} .ezr-full-caption{display:none;} .ezr-full-end{grid-column:2;} .ezr-full-status{grid-column:1;} }
@media(max-width:520px) { .ezr-full-bar{grid-template-columns:minmax(0,1fr);gap:8px;} .ezr-full-end{grid-column:1;grid-row:1;} .ezr-full-controls{grid-column:1;grid-row:2;} .ezr-full-status{grid-column:1;grid-row:3;} }
@media(max-width:520px) { .ezr-full-page-status{grid-row:4;} }
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
export function createFullTranslation({ doc = document, request = message => chrome.runtime.sendMessage(message), isReaderActive = () => false, onVisibilityChange = () => {} }) {
  let bar, status, start, stop, retry, bilingualInput, originalSelection, originalRoot, levelInput, cardsInput, providerInput, modeControl, targetInput, readerTools, dockButton;
  let reader = null, website = [], readerGroups = [], pdfGroups = [], notes = null, view = null;
  let enabled = false, bilingual = true, running = false, epoch = 0, revision = 0, url = doc.location.href, signature = '';
  let visible = false, originalSuspended = false, selectionPrefs = normalizeTranslation();
  let navigationTimer = 0, savingPreferences = false, unsubscribePdf, pageStatus, bubbles;
  const bubbleState = { cards:new Map(), closed:new Set() };
  let activeProvider = selectionPrefs.provider;
  const cache = new Map(), failures = new Map();
  const make = (tag, cls, text) => { const element = doc.createElement(tag); element.className = cls; if (text) element.textContent = text; return element; };
  const cacheKey = (text, provider = activeProvider) => JSON.stringify([provider, text]);
  const pdfAllowed = group => !reader?.pdfTranslation?.isOriginal?.(group.id);
  const textAllowed = text => !reader?.isPdf || pdfGroups.some(group => pdfAllowed(group) && group.chunks.includes(text));
  const failedTexts = (provider = activeProvider) => [...failures.values()]
    .filter(item => item.provider === provider && textAllowed(item.source) && (!cache.has(cacheKey(item.source, provider)) || (item.cards && selectionPrefs.bubbleCards
      && (cache.get(cacheKey(item.source, provider))?.wordsLevel !== item.level || cache.get(cacheKey(item.source, provider))?.wordsExplanations !== item.explanations)
      ))).map(item => item.source);
  const failedPageNumbers = () => {
    if (!reader?.isPdf) return [];
    const texts = new Set(failedTexts());
    return [...new Set([...pdfGroups.filter(group => pdfAllowed(group) && group.chunks.some(chunk => texts.has(chunk))).map(group => group.page),
      ...(reader.pdfTranslation?.state.failedPages || [])])].sort((a,b) => a - b);
  };
  const message = text => { if (status) status.textContent = text; };
  const closeSelections = () => { originalSelection?.close(); reader?.closeSelection(); bubbles?.minimize(); };
  const cardsChanged = (before, next) => next.bubbleCards !== before.bubbleCards || next.level !== before.level || next.explanations !== before.explanations;
  function refreshCards(continueTranslation = false) {
    if (enabled && !running && !savingPreferences && (selectionPrefs.bubbleCards || continueTranslation)) void translate();
  }
  function bubbleSources() {
    const wordsFor = chunks => chunks.flatMap(chunk => {
      const result = cache.get(cacheKey(chunk));
      return result?.wordsLevel === selectionPrefs.level && result.wordsExplanations === selectionPrefs.explanations ? result.words || [] : [];
    });
    if (reader?.isPdf && !isReaderActive()) {
      const elements = new Map([...doc.querySelectorAll('.ezr-pdf-text')].map(node => [node.dataset.box, node]));
      return pdfGroups.flatMap(group => {
      const element = elements.get(group.id);
      if (!element) return [];
      const walker = doc.createTreeWalker(element, 4), nodes = []; let node;
      while ((node = walker.nextNode())) nodes.push(node);
      return [{ nodes, source:group.source, words:wordsFor(group.chunks), translated:true }];
      });
    }
    return (isReaderActive() ? readerGroups : website).map(group => ({
      nodes:group.runs.flatMap(run => run.inserted ? [run.inserted] : run.nodes.map(item => item.node)),
      source:group.source, words:wordsFor(group.chunks), translated:!!group.appliedResults && !group.appliedMode,
    }));
  }
  function syncBubbles() {
    bubbles?.update({ active:enabled && selectionPrefs.bubbleCards && !originalSuspended && !(reader?.isPdf && !isReaderActive() && reader.pdfTranslation?.state.editing),
      target:selectionPrefs.target, selectionEnabled:selectionPrefs.enabled, original:!isReaderActive() });
  }
  function ensureUI() {
    if (bar || !reader) return;
    if (!navigationTimer) navigationTimer = setInterval(checkUrl, 750);
    bar = make('div', 'ezr-full-bar'); bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '翻译工具栏'); bar.id = 'ezr-translation-bar'; bar.hidden = true;
    start = make('button', 'ezr-full-start', '全文翻译'); stop = make('button', 'ezr-full-stop', '停止'); stop.hidden = true;
    retry = make('button', 'ezr-full-retry', '重试失败项'); retry.hidden = true;
    retry.addEventListener('click', () => { void translate(true); });
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
    const bilingualLabel = make('label', ''); bilingualInput = make('input', 'ezr-full-bilingual'); bilingualInput.type = 'checkbox'; bilingualInput.checked = true; bilingualLabel.append(bilingualInput, doc.createTextNode('双语对照'));
    const cardsLabel = make('label', ''); cardsInput = make('input', 'ezr-full-cards'); cardsInput.type = 'checkbox'; cardsInput.checked = selectionPrefs.wordCards; cardsLabel.append(cardsInput, doc.createTextNode('划词生词卡'));
    levelInput = make('select', 'ezr-full-level'); levelInput.setAttribute('aria-label', '生词卡英语水平');
    for (const [value, label] of ENGLISH_LEVELS) { const option = make('option', '', label); option.value = value; levelInput.appendChild(option); }
    levelInput.value = selectionPrefs.level;
    const settings = make('button', 'ezr-full-settings', '翻译设置'), close = make('button', 'ezr-full-close ezr-toolbar-close', ''); close.setAttribute('aria-label', '关闭翻译工具栏'); close.title = '关闭翻译工具栏'; close.appendChild(closeIcon(doc));
    modeControl = createTranslationMode({ doc, className:'ezr-full-mode', onChange:patch => { void preferences(patch); } });
    const preferencesGroup = make('div', 'ezr-full-preferences'); preferencesGroup.append(modeControl.element, settings);
    status = make('span', 'ezr-full-status', ''); status.setAttribute('aria-live', 'polite');
    pageStatus = make('span', 'ezr-full-status ezr-full-page-status', ''); pageStatus.setAttribute('aria-live', 'polite');
    readerTools = make('button', 'ezr-full-reader-tools', '阅读工具');
    readerTools.title = '显示阅读工具栏';
    readerTools.setAttribute('aria-label', '显示阅读工具栏');
    readerTools.setAttribute('aria-controls', 'ezr-reading-bar');
    readerTools.addEventListener('click', () => reader?.showMainToolbar?.());
    dockButton = make('button', 'ezr-full-dock ezr-toolbar-dock');
    dockButton.addEventListener('click', () => reader?.setTranslationDock?.(reader?.getTranslationDock?.() === 'bottom' ? 'top' : 'bottom'));
    const end = make('div', 'ezr-toolbar-end ezr-full-end');
    end.append(readerTools, dockButton, close);
    const caption = make('span', 'ezr-full-caption', '翻译');
    const controls = make('div', 'ezr-full-controls');
    controls.append(providerInput, targetLabel, start, stop, retry, inputText, bilingualLabel, cardsLabel, levelInput, preferencesGroup);
    bar.append(caption, controls, end, status, pageStatus);
    for (const button of bar.querySelectorAll('button')) button.type = 'button';
    start.addEventListener('click', () => { if (enabled || running) showOriginal(); else void translate(); });
    inputText.addEventListener('click', () => { reader?.openTextTranslation?.(); });
    stop.addEventListener('click', () => { epoch++; running = false; sync(); message('已停止，已完成的译文保留。可切回原文后继续翻译。'); });
    bilingualInput.addEventListener('change', () => { closeSelections(); bilingual = bilingualInput.checked; apply(readerGroups, true); notes?.clear(); syncBubbles(); });
    async function preferences(patch) {
      if (savingPreferences) return;
      savingPreferences = true;
      const before = selectionPrefs;
      if (Object.hasOwn(patch, 'target') && patch.target !== before.target) invalidate();
      selectionPrefs = normalizeTranslation({ ...before, ...patch });
      const continueTranslation = cardsChanged(before, selectionPrefs) && running;
      if (continueTranslation) { epoch++; running = false; }
      if (before.enabled !== selectionPrefs.enabled || before.bubbleCards !== selectionPrefs.bubbleCards) closeSelections();
      sync();
      try {
        const result = await request({ type: 'ezr:translation:preferences', patch });
        if (!result?.ok) throw new Error(result?.message || '设置保存失败。');
        selectionPrefs = normalizeTranslation(result.config); notes?.clear(); sync();
      } catch (error) { selectionPrefs = before; message(error.message); }
      finally { savingPreferences = false; sync(); }
      if (cardsChanged(before, selectionPrefs) || continueTranslation) refreshCards(continueTranslation);
    }
    cardsInput.addEventListener('change', () => { void preferences({ wordCards: cardsInput.checked }); });
    levelInput.addEventListener('change', () => { void preferences({ level: levelInput.value }); });
    providerInput.addEventListener('change', () => { void preferences({ provider: providerInput.value }); });
    targetInput.addEventListener('change', () => { void preferences({ target:targetInput.value }); });
    settings.addEventListener('click', () => { void request({ type: 'ezr:translation:options' }); });
    close.addEventListener('click', () => setToolbarVisible(false, true));
    originalRoot = make('div', 'ezr-original-selection'); reader.root.appendChild(originalRoot);
    originalSelection = createTranslation({ root: originalRoot, article: doc.body, doc, request, mode: 'original',
      isActive: () => !!reader && !isReaderActive() && !originalSuspended, canSelect: range => !isTranslatedSelection(range, website), getView: () => view,
      getDocument: () => ({ title: doc.title, blocks: [] }) });
    void request({ type: 'ezr:translation:config' }).then(result => { if (result?.ok) { selectionPrefs = normalizeTranslation(result.config); sync(); } }).catch(() => {});
    place();
  }
  function showOriginal() {
    epoch++; running = false; enabled = false; closeSelections();
    restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); notes?.clear();
    reader?.pdfTranslation?.restore();
    sync(); message('已显示原文，再次翻译会复用已有结果。');
  }
  function sync() {
    if (!bar) return;
    providerInput.value = selectionPrefs.provider;
    targetInput.value = selectionPrefs.target;
    readerTools.setAttribute('aria-expanded', String(reader?.isMainToolbarVisible?.() !== false));
    const atBottom = reader?.getTranslationDock?.() === 'bottom';
    const destination = atBottom ? 'top' : 'bottom';
    if (dockButton.dataset.target !== destination) {
      dockButton.replaceChildren(dockIcon(doc, destination));
      dockButton.dataset.target = destination;
    }
    const dockLabel = atBottom ? '把翻译工具栏移到窗口顶部' : '把翻译工具栏移到窗口底部';
    dockButton.title = dockLabel;
    dockButton.setAttribute('aria-label', dockLabel);
    dockButton.setAttribute('aria-pressed', String(atBottom));
    for (const input of [providerInput, targetInput, cardsInput, levelInput]) input.disabled = savingPreferences;
    modeControl.update(selectionPrefs, savingPreferences);
    levelInput.disabled ||= running;
    start.disabled = savingPreferences; start.textContent = enabled || running ? '显示原文' : '全文翻译';
    start.setAttribute('aria-pressed', String(enabled || running));
    stop.hidden = !running;
    const pages = failedPageNumbers(), failed = reader?.isPdf ? pages.length : failedTexts().length;
    retry.hidden = failed === 0;
    retry.disabled = running || savingPreferences || !!reader?.pdfTranslation?.state.retrying;
    retry.textContent = (reader?.isPdf ? '重试失败页' : '重试失败项') + '（' + failed + '）';
    retry.setAttribute('aria-label', reader?.isPdf ? '重试第 ' + pages.join('、') + ' 页' : '重试 ' + failed + ' 个翻译失败项');
    retry.title = reader?.isPdf ? '重试失败页中的未完成内容，复用已有译文' : '只重试未成功的翻译片段';
    const renderPages = reader?.pdfTranslation?.state.failedPages || [];
    pageStatus.textContent = pages.length ? '第 ' + pages.join('、') + ' 页未完成。'
      + (renderPages.length ? '其中第 ' + renderPages.join('、') + ' 页译文显示失败。' : '') + '可点击「重试失败页」，已有译文会保留。' : '';
    bilingualInput.checked = bilingual; bilingualInput.parentElement.hidden = !isReaderActive();
    cardsInput.parentElement.hidden = !isReaderActive() || !selectionPrefs.enabled;
    levelInput.hidden = (!isReaderActive() || !selectionPrefs.enabled) && !selectionPrefs.bubbleCards;
    cardsInput.checked = selectionPrefs.wordCards; levelInput.value = selectionPrefs.level;
    syncBubbles();
  }
  function place() {
    if (!bar || !reader) return;
    const host = reader.translationToolbarHost || reader.toolbarHost;
    if (host) { if (bar.parentNode !== host) host.appendChild(bar); }
    else reader.root.insertBefore(bar, reader.article.parentElement);
    bar.hidden = !visible; reader?.onTranslationVisibility?.(visible); sync();
  }
  function setToolbarVisible(value, remember = false) {
    visible = value === true;
    if (reader) { ensureUI(); place(); }
    if (remember) onVisibilityChange(visible);
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
  function applyPdf() {
    if (!enabled || !reader?.pdfTranslation) return;
    reader.pdfTranslation.apply(pdfGroups.flatMap(group => {
      const results = group.chunks.map(chunk => cache.get(cacheKey(chunk)));
      return results.every(Boolean) ? [{ id:group.id, text:joinTranslations(results) }] : [];
    }));
  }
  function invalidate() {
    epoch++; revision++; running = false; enabled = false;
    restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); website = []; readerGroups = [];
    pdfGroups = []; reader?.pdfTranslation?.restore();
    cache.clear(); failures.clear(); bubbleState.cards.clear(); bubbleState.closed.clear(); view = null; notes?.clear(); closeSelections();
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
  async function translate(retryOnly = false) {
    if (!reader) return;
    ensureUI(); checkUrl(); if (running || savingPreferences) return;
    if (retryOnly && !failedTexts().length && !failedPageNumbers().length) { sync(); return; }
    closeSelections();
    running = true; const token = ++epoch, version = revision, requestUrl = url; sync();
    try {
      // A display failure already has translated text; no API or credentials are needed.
      if (retryOnly && reader.isPdf && !failedTexts().length) {
        message('正在重试失败页，复用已有译文…');
        await reader.pdfTranslation.retryFailedPages({ shouldContinue:() => token === epoch });
        if (token === epoch) message(failedPageNumbers().length ? '仍有页面显示失败，可再次重试；已有译文保留。' : '失败页已恢复，未重复请求翻译。');
        return;
      }
      if (reader.prepareTranslation) await reader.prepareTranslation();
      if (token !== epoch) return;
      if (reader.isPdf) {
        const source = await reader.pdfTranslation?.prepare();
        if (token !== epoch) return;
        if (!source) throw new Error('PDF 翻译尚未准备好，请重新打开文档。');
        pdfGroups = source.map(group => ({ ...group, chunks:splitTranslationText(group.source) }));
      }
      const reply = await request({ type: 'ezr:translation:config' });
      if (token !== epoch) return;
      if (!reply?.ok) throw new Error(reply?.message || '无法读取翻译设置。');
      const provider = reply.config.provider;
      if (provider === 'deepseek' && !reply.hasKey && !(reader.isPdf && pdfGroups.length && pdfGroups.every(group => !pdfAllowed(group)))) throw new Error('请填写 DeepSeek API Key，或切换到免费翻译。');
      activeProvider = provider;
      const nextSignature = JSON.stringify([reply.config.source, reply.config.target, reply.config.model, reply.config.stylePrompt]);
      if (signature && signature !== nextSignature) { invalidate(); signature = nextSignature; void translate(); return; }
      signature = nextSignature; selectionPrefs = normalizeTranslation(reply.config);
      restoreTranslationGroups(website); website = reader.isPdf ? [] : collectTranslationGroups(doc.body, doc);
      if (!isReaderActive()) website = prioritizeWebsiteGroups(website, doc);
      if (!view) view = { id: crypto.randomUUID(), title: doc.title, language: doc.documentElement.lang, fullDocument: true,
        context: sampleContext(reader.isPdf ? pdfGroups.filter(pdfAllowed).map(group => group.source).join('\n\n') : isReaderActive() ? reader.getDocument().blocks.map(block => block.text || '').join('\n\n') : website.map(group => group.source).join('\n\n')) };
      if (reader) { restoreTranslationGroups(readerGroups); readerGroups = collectReader(); }
      const groups = reader.isPdf ? pdfGroups.filter(pdfAllowed) : isReaderActive() ? readerGroups : website;
      const texts = [...new Set([...groups.flatMap(group => group.chunks), ...(retryOnly ? failedTexts(provider) : [])])];
      if (!texts.length) {
        if (reader.isPdf && reader.pdfTranslation?.state.originals.length) { view = null; message('所有可翻译文本框均已标记为原文，未发送翻译请求。'); return; }
        throw new Error('当前视图没有可翻译的文字。');
      }
      enabled = true; apply(website, false); apply(readerGroups, true); applyPdf();
      const wantsCards = provider === 'deepseek' && selectionPrefs.bubbleCards;
      const pending = retryOnly ? failedTexts(provider) : texts.filter(text => {
        const result = cache.get(cacheKey(text));
        return !result || (wantsCards && (result.wordsLevel !== selectionPrefs.level || result.wordsExplanations !== selectionPrefs.explanations));
      });
      let completed = texts.filter(text => cache.has(cacheKey(text))).length;
      let lastError = '';
      while (pending.length && token === epoch && doc.location.href === url) {
        // A mark made during translation takes effect before the next request; duplicates still translate where unmarked.
        for (let index = pending.length - 1; index >= 0; index--) if (!textAllowed(pending[index])) pending.splice(index,1);
        if (!pending.length) break;
        const batch = []; let length = 0;
        // Bubble mode combines up to four short runs into one request, with no queued next batch.
        while (pending.length && batch.length < (wantsCards ? 4 : 1) && length + pending[0].length <= 2000) { const text = pending.shift(); batch.push(text); length += text.length; }
        message(`翻译中 ${completed}/${texts.length} · ${provider === 'free' ? 'MyMemory 免费翻译' : 'DeepSeek'} · 可随时停止`);
        let result;
        try { result = await request({ type: 'ezr:translation:full', provider, texts: batch, view,
          ...(wantsCards ? { excludeTerms:[...bubbleState.closed].map(key => JSON.parse(key)[0]).slice(0, 80) } : {}) }); }
        catch (error) { result = { ok:false, message:error?.message || '无法连接翻译服务，请重试。' }; }
        // Successful late results may be cached, but only the current run owns failure/UI state.
        if (doc.location.href !== requestUrl || revision !== version || signature !== nextSignature) return;
        const accepted = new Map();
        for (const item of Array.isArray(result?.results) ? result.results : []) {
          if (!batch.includes(item?.source) || typeof item.text !== 'string' || !item.text.trim()) continue;
          accepted.set(item.source, item);
          cache.set(cacheKey(item.source, provider), item);
        }
        if (token !== epoch) return;
        for (const source of batch) {
          const id = cacheKey(source, provider);
          if (accepted.has(source)) failures.delete(id);
          else {
            lastError = result?.error || result?.message || '未收到有效译文，请重试。';
            failures.set(id, { source, provider, message:lastError, cards:wantsCards, level:selectionPrefs.level, explanations:selectionPrefs.explanations });
          }
        }
        completed = texts.filter(text => textAllowed(text) && cache.has(cacheKey(text))).length;
        apply(website, false); apply(readerGroups, true); applyPdf(); sync();
      }
      if (token === epoch) {
        if (retryOnly && reader.isPdf) await reader.pdfTranslation.retryFailedPages({ shouldContinue:() => token === epoch });
        if (token !== epoch) return;
        const failed = failedTexts(provider).length;
        const retryLabel = reader.isPdf ? '重试失败页' : '重试失败项';
        message(`已翻译 ${completed}/${texts.length} · ${provider === 'free' ? 'MyMemory' : 'DeepSeek'}${failed ? ' · ' + failed + ' 项失败，可点击「' + retryLabel + '」。' + (lastError ? ' ' + lastError : '') : ' · 切换视图复用结果'}`);
      }
    } catch (error) { if (token === epoch) message(error.message || '全文翻译失败，请重试。'); }
    finally { if (token === epoch) { running = false; sync(); } }
  }
  const storageChanged = (changes, area) => {
    if (area !== 'local' || !changes[TRANSLATION_KEY]) return;
    const next = normalizeTranslation(changes[TRANSLATION_KEY].newValue);
    const changedCards = cardsChanged(selectionPrefs, next);
    const continueTranslation = running && changedCards;
    if (continueTranslation) { epoch++; running = false; }
    const nextSignature = JSON.stringify([next.source, next.target, next.model, next.stylePrompt]);
    if (signature && signature !== nextSignature) { invalidate(); signature = nextSignature; }
    if (activeProvider !== next.provider) {
      epoch++; running = false; enabled = false;
      // Provider changes keep the captured selection text; restoring the view does not rewrite that snapshot.
      restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); notes?.clear();
      reader?.pdfTranslation?.restore();
      activeProvider = next.provider;
      if (status) status.textContent = '翻译服务已切换，点击全文翻译；已有结果会保留在缓存中。';
    }
    if (!next.wordCards || !next.enabled || next.level !== selectionPrefs.level || next.explanations !== selectionPrefs.explanations) notes?.clear();
    if (next.enabled !== selectionPrefs.enabled || next.bubbleCards !== selectionPrefs.bubbleCards) closeSelections();
    selectionPrefs = next; sync();
    if (changedCards) refreshCards(continueTranslation);
  };
  chrome.storage.onChanged.addListener(storageChanged);
  // SPA navigation must also invalidate a stopped or fully translated view.
  doc.defaultView.addEventListener?.('pagehide', () => { clearInterval(navigationTimer); chrome.storage.onChanged.removeListener(storageChanged); }, { once: true });
  return {
    show() { if (reader) setToolbarVisible(true, true); },
    toggle() { if (reader) setToolbarVisible(!visible, true); }, translate, setToolbarVisible,
    mainToolbarChanged() { sync(); },
    resetDocument() { invalidate(); signature = ''; },
    getView() { checkUrl(); return view; },
    isTranslatedSelection(range) { checkUrl(); return isTranslatedSelection(range, website) || isTranslatedSelection(range, readerGroups); },
    addCards(cards, range) {
      for (const card of cards) if (!bubbleState.closed.has(bubbleKey(card))) bubbleState.cards.set(bubbleKey(card), card);
      if (enabled && selectionPrefs.bubbleCards) { syncBubbles(); return true; }
      return enabled && selectionPrefs.wordCards && selectionPrefs.enabled && notes ? notes.add(cards, range) : false;
    },
    beforeRead() { originalSuspended = true; closeSelections(); restoreTranslationGroups(website); syncBubbles(); },
    afterRead() { originalSuspended = false; if (enabled) apply(website, false); sync(); },
    readerPaint() { notes?.clear(); if (reader && enabled) { readerGroups = collectReader(); apply(readerGroups, true); } syncBubbles(); },
    bindReader(value) {
      reader = value; const style = make('style', 'ezr-full-style'); style.textContent = CSS; reader.root.appendChild(style);
      unsubscribePdf?.(); unsubscribePdf = reader.pdfTranslation?.subscribe?.(sync);
      notes = createTranslationNotes({ ...value, doc, request });
      bubbles = createBubbleCards({ ...value, doc, request, state:bubbleState, getSources:bubbleSources });
      readerGroups = enabled ? collectReader() : []; ensureUI(); apply(readerGroups, true); place();
    },
    unbindReader() {
      epoch++; running = false; enabled = false; closeSelections();
      unsubscribePdf?.(); unsubscribePdf = null;
      restoreTranslationGroups(website); restoreTranslationGroups(readerGroups); readerGroups = []; pdfGroups = []; reader?.pdfTranslation?.restore();
      notes?.destroy(); notes = null; originalSelection?.destroy(); originalSelection = null;
      bubbles?.destroy(); bubbles = null;
      originalRoot?.remove(); originalRoot = null; bar?.remove(); bar = null; status = null; reader = null;
    },
    previewChanged() {
      closeSelections();
      // PDF translations belong to positioned text boxes and survive view changes.
      applyPdf();
      if (isReaderActive()) {
        restoreTranslationGroups(website);
        if (enabled) { restoreTranslationGroups(readerGroups); readerGroups = collectReader(); apply(readerGroups, true); }
      }
      else apply(website, false);
      place();
    },
    get isToolbarVisible() { return !!reader && !!bar && !bar.hidden; },
    get isSelectionOpen() { return !!originalSelection?.isOpen || !!bubbles?.isOpen; },
    closeSelection() { originalSelection?.close(); bubbles?.minimize(); },
    get state() { return { enabled, running, bilingual, cached: cache.size, failed: failedTexts().length }; },
  };
}
