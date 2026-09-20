import { MAX_SELECTION, TRANSLATION_KEY, ENGLISH_LEVELS, normalizeTranslation, translationContextKey, sampleContext, languageName } from '../translation/config.js';
import { isWordSelection, normalizeWordCard } from '../translation/word-card.js';
import { downloadWordCards } from '../translation/card-download.js';

/** Selection UI belongs only to the reader's shadow tree. No remote text is parsed as HTML. */
export function createTranslation({ root, article, getDocument, doc = document, request = message => chrome.runtime.sendMessage(message),
  mode = 'reader', isActive = () => true, canSelect = () => true, getView = () => null, onCards = () => {} }) {
  const abort = new AbortController();
  const shadow = root.getRootNode();
  let prefs = normalizeTranslation(), ready = false, selected = null, serial = 0, destroyed = false, viewId = crypto.randomUUID();
  let context = '', selectionTimer = 0, dismissed = '', lastUrl = doc.location.href;
  let currentCard = null, lastTranslation = null;
  let vocabulary = [], preloadTimer = 0, selecting = false, learningBusy = false, retryScope = '', studyScope = '';
  let pendingPreferences = 0, preferenceRevision = 0, configRevision = 0;
  const make = (tag, cls, text) => {
    const element = doc.createElement(tag);
    element.className = cls;
    if (text) element.textContent = text;
    return element;
  };
  const panel = make('div', 'ezr-translation');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '划词翻译');
  const head = make('div', 'ezr-translation-head');
  const label = make('span', '', '划词翻译');
  const closeButton = make('button', 'ezr-translation-close', '×');
  closeButton.setAttribute('aria-label', '关闭翻译');
  head.append(label, closeButton);
  const source = make('div', 'ezr-translation-source');
  const actions = make('div', 'ezr-translation-actions');
  const free = make('button', 'ezr-translate-free', '免费翻译');
  const deepseek = make('button', 'ezr-translate-deepseek', 'DeepSeek');
  free.setAttribute('aria-pressed', 'true');
  deepseek.setAttribute('aria-pressed', 'false');
  const options = make('button', 'ezr-translation-options', '设置');
  actions.append(free, deepseek, options);
  const quick = make('div', 'ezr-translation-quick');
  const toggles = {};
  for (const [key, title] of [['preload', '自动翻译'], ['explanations', '讲解'], ['wordCards', '生成卡片']]) {
    const wrapper = make('label', '');
    const input = make('input', `ezr-pref-${key}`); input.type = 'checkbox';
    input.addEventListener('change', () => { void changePreferences({ [key]: input.checked }); });
    toggles[key] = input; wrapper.append(input, doc.createTextNode(title)); quick.appendChild(wrapper);
  }
  const studyBar = make('div', 'ezr-study-bar');
  const level = make('select', 'ezr-study-level'); level.setAttribute('aria-label', '英语水平');
  for (const [value, title] of ENGLISH_LEVELS) { const option = make('option', '', title); option.value = value; level.appendChild(option); }
  const study = make('button', 'ezr-study-article', '本篇生词');
  study.title = '按英语水平从当前阅读内容节选中挑选生词';
  studyBar.append(level, study);
  const output = make('div', 'ezr-translation-result');
  output.setAttribute('aria-live', 'polite');
  const detail = make('div', 'ezr-translation-detail', '点击后发送选中文字');
  const meta = make('div', 'ezr-word-meta');
  const knowledge = make('div', 'ezr-word-knowledge');
  const credit = make('div', 'ezr-word-credit');
  const cardActions = make('div', 'ezr-word-actions');
  const save = make('button', 'ezr-word-save', '加入生词本');
  const exportButton = make('button', 'ezr-word-export', '导出 Anki');
  const retry = make('button', 'ezr-word-retry', '重试扩展');
  retry.hidden = true;
  cardActions.hidden = true;
  cardActions.append(save, exportButton);
  panel.append(head, source, meta, actions, quick, studyBar, output, knowledge, credit, cardActions, retry, detail);
  root.appendChild(panel);
  for (const button of panel.querySelectorAll('button')) {
    button.type = 'button';
    button.addEventListener('mousedown', event => event.preventDefault());
  }
  const clearRemote = () => { void request({ type: 'ezr:translation:clear' }).catch(() => {}); };
  const alive = (chosen, token) => !destroyed && token === serial && selected === chosen && chosen.url === doc.location.href
    && prefs.enabled && root.isConnected && isActive() && canSelect(chosen.range);
  const exportable = () => mode !== 'original' && prefs.wordCards ? vocabulary.length ? vocabulary : currentCard ? [currentCard] : [] : [];
  function controls() {
    for (const [key, input] of Object.entries(toggles)) input.checked = prefs[key];
    level.value = prefs.level;
    studyBar.hidden = prefs.provider !== 'deepseek' || (!prefs.explanations && !prefs.wordCards);
    free.setAttribute('aria-pressed', String(prefs.provider === 'free'));
    deepseek.setAttribute('aria-pressed', String(prefs.provider === 'deepseek'));
    cardActions.hidden = exportable().length === 0;
    if (mode === 'original') { quick.querySelectorAll('label').forEach((element, index) => { if (index > 0) element.hidden = true; }); studyBar.hidden = true; }
    if (selected && !panel.hidden) position(selected.rect);
  }
  function schedulePreload() {
    clearTimeout(preloadTimer);
    if (!ready || !prefs.enabled || !prefs.preload || !selected || selected.text.length > MAX_SELECTION || selecting) return;
    const chosen = selected, token = serial;
    preloadTimer = setTimeout(() => {
      if (alive(chosen, token) && prefs.preload && !selecting) void run(prefs.provider);
    }, 450);
  }
  async function changePreferences(patch) {
    const revision = ++preferenceRevision, chosen = selected;
    const hadResult = !!lastTranslation || free.disabled || vocabulary.length > 0 || learningBusy, previousScope = studyScope;
    const refresh = ['provider', 'explanations', 'wordCards', 'level'].some(key => Object.hasOwn(patch, key));
    clearTimeout(preloadTimer);
    prefs = normalizeTranslation({ ...prefs, ...patch }); controls();
    if (refresh) {
      serial++; free.disabled = deepseek.disabled = false; learningBusy = false;
      meta.textContent = knowledge.textContent = credit.textContent = ''; retry.hidden = true;
      currentCard = null; vocabulary = []; controls();
    }
    pendingPreferences++;
    try {
      const reply = await request({ type: 'ezr:translation:preferences', patch });
      if (!reply?.ok) throw new Error(reply?.message || '设置保存失败。');
      if (revision !== preferenceRevision || destroyed) return;
      prefs = normalizeTranslation(reply.config); controls();
      if (selected === chosen && chosen) {
        if (refresh && hadResult) {
          if (previousScope === 'article') {
            if (prefs.provider === 'deepseek' && (prefs.explanations || prefs.wordCards)) void studyWords(chosen, ++serial, true);
            else if (lastTranslation) void run(prefs.provider);
          } else void run(prefs.provider);
        }
        else if (!lastTranslation) schedulePreload();
      }
    } catch (error) { detail.textContent = error.message; }
    finally { pendingPreferences--; if (!pendingPreferences) void loadConfig(); }
  }
  function close() {
    clearTimeout(preloadTimer);
    if (selected) dismissed = selected.text;
    selected = null;
    serial++;
    panel.hidden = true;
    free.disabled = deepseek.disabled = false;
    currentCard = lastTranslation = null;
    vocabulary = []; learningBusy = false; studyScope = '';
  }
  function position(rect) {
    const width = Math.min(360, doc.documentElement.clientWidth - 20);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(10, Math.min(rect.left, doc.documentElement.clientWidth - width - 10))}px`;
    const height = Math.min(panel.offsetHeight, innerHeight - 24);
    let top = rect.bottom + 10;
    if (top + height > innerHeight - 10) top = Math.max(10, rect.top - height - 10);
    panel.style.top = `${top}px`;
  }
  function capture() {
    if (destroyed || !prefs.enabled || selecting || !isActive() || !root.isConnected || shadow.querySelector('.ezr-settings.is-open')
      || (mode !== 'original' && shadow.host?.hasAttribute('data-ezr-original'))) return;
    if (doc.location.href !== lastUrl) { reset(); lastUrl = doc.location.href; }
    const selection = mode === 'original' ? doc.getSelection() : shadow.getSelection?.() || doc.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    if (!article.contains(selection.anchorNode) || !article.contains(selection.focusNode)) return;
    if (!canSelect(selection.getRangeAt(0))) { close(); return; }
    // Source-page CSS capitalization can affect Selection.toString(). Send the
    // original text nodes so display preferences do not change translation/cache keys.
    const text = mode === 'original' ? selection.getRangeAt(0).cloneContents().textContent.trim() : selection.toString().trim();
    if (!text || text === dismissed) return;
    const range = selection.getRangeAt(0);
    if (text === selected?.text && selected.range?.startContainer === range.startContainer && selected.range?.startOffset === range.startOffset
      && selected.range?.endContainer === range.endContainer && selected.range?.endOffset === range.endOffset) return;
    const rect = range.getBoundingClientRect();
    const node = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
    const block = node.closest(mode === 'original' ? 'p,h1,h2,h3,h4,h5,h6,li,td,div' : '[data-ezr-type]');
    let nearby = block?.textContent || '';
    if (block && nearby.length > 1500) {
      const prefix = range.cloneRange();
      prefix.selectNodeContents(block);
      try { prefix.setEnd(selection.anchorNode, selection.anchorOffset); } catch { /* Fall back to paragraph start. */ }
      const start = Math.max(0, prefix.toString().length - 500);
      nearby = nearby.slice(start, start + 1500);
    }
    selected = { text, nearby: nearby.slice(0, 1500), rect, url: doc.location.href, range: range.cloneRange() };
    serial++;
    panel.hidden = false;
    const word = isWordSelection(text);
    panel.classList.toggle('is-word-card', mode !== 'original' && word);
    label.textContent = mode !== 'original' && word && prefs.wordCards ? '单词卡' : '划词翻译';
    currentCard = lastTranslation = null;
    vocabulary = []; learningBusy = false; studyScope = '';
    meta.textContent = knowledge.textContent = credit.textContent = '';
    cardActions.hidden = true;
    retry.hidden = true;
    controls();
    source.textContent = text.slice(0, 160) + (text.length > 160 ? '…' : '');
    output.textContent = text.length > MAX_SELECTION ? `一次最多翻译 ${MAX_SELECTION} 个字符，请缩短选区。` : '';
    detail.textContent = prefs.preload ? `将自动使用 ${prefs.provider === 'deepseek' ? 'DeepSeek' : '免费翻译'}` : '点击翻译；也可勾选自动翻译';
    free.disabled = deepseek.disabled = text.length > MAX_SELECTION;
    position(rect);
    schedulePreload();
  }
  async function run(provider) {
    clearTimeout(preloadTimer);
    if (!selected || selected.url !== doc.location.href || !isActive() || !canSelect(selected.range)) { close(); return; }
    const chosen = selected, token = ++serial;
    studyScope = '';
    const word = isWordSelection(chosen.text);
    panel.classList.toggle('is-word-card', mode !== 'original' && word);
    label.textContent = mode !== 'original' && word && prefs.wordCards ? '单词卡' : '划词翻译';
    source.textContent = chosen.text.slice(0, 160) + (chosen.text.length > 160 ? '…' : '');
    free.setAttribute('aria-pressed', String(provider === 'free'));
    deepseek.setAttribute('aria-pressed', String(provider === 'deepseek'));
    free.disabled = deepseek.disabled = true;
    currentCard = lastTranslation = null;
    vocabulary = []; learningBusy = false; retry.hidden = true;
    cardActions.hidden = true;
    meta.textContent = knowledge.textContent = credit.textContent = '';
    output.textContent = provider === 'deepseek' ? '正在翻译，首次使用会先分析阅读语境…' : '正在翻译…';
    detail.textContent = provider === 'deepseek' ? 'DeepSeek' : 'MyMemory · 免费翻译';
    position(chosen.rect);
    try {
      const ir = getDocument();
      if (!context) context = sampleContext(ir.blocks.map(block => block.text || '').join('\n\n'));
      const payload = { provider, text: chosen.text, nearby: chosen.nearby,
        view: getView() || { id: viewId, context, title: ir.title || doc.title, language: doc.documentElement.lang } };
      const reply = await request({ type: 'ezr:translation:run', ...payload });
      if (!alive(chosen, token)) return;
      if (!reply?.ok) throw new Error(reply?.message || '翻译服务暂时无响应，请重试。');
      output.textContent = reply.text;
      detail.textContent = `${provider === 'deepseek' ? 'DeepSeek' : 'MyMemory'} · ${languageName(reply.target)}${reply.cached ? ' · 已缓存' : ''}`;
      lastTranslation = { ...payload, translation: reply.text, sourceLanguage: reply.source || doc.documentElement.lang || 'auto' };
      if (mode === 'original') return;
      if (isWordSelection(chosen.text)) {
        const sentences = chosen.nearby.match(/[^.!?。！？]+[.!?。！？]?/g) || [];
        const sentence = sentences.find(line => line.toLowerCase().includes(chosen.text.toLowerCase())) || chosen.nearby;
        currentCard = normalizeWordCard({ term: chosen.text, translation: reply.text,
          provider: provider === 'deepseek' ? 'ai' : 'translation',
          level: provider === 'deepseek' ? prefs.level : '',
          sourceLanguage: reply.source || doc.documentElement.lang || 'auto', targetLanguage: reply.target,
          sourceSentence: sentence, pageUrl: chosen.url, pageTitle: ir.title || doc.title });
        lastTranslation = { ...lastTranslation, translation: currentCard.translation, sourceLanguage: currentCard.sourceLanguage };
        output.textContent = currentCard.translation;
        free.disabled = deepseek.disabled = false;
        if (prefs.explanations) await expandCard(chosen, token);
        else { controls(); save.disabled = exportButton.disabled = false; save.textContent = '加入生词本'; await autoSave(chosen, token); }
      } else if (provider === 'deepseek' && (prefs.explanations || prefs.wordCards)) {
        free.disabled = deepseek.disabled = false;
        await studyWords(chosen, token, false);
      }
    } catch (error) {
      if (!destroyed && token === serial) output.textContent = error.message || '翻译失败，请重试。';
    } finally {
      if (!destroyed && token === serial) {
        free.disabled = deepseek.disabled = false;
        position(chosen.rect);
        if (exportable().length && !learningBusy && onCards(exportable(), chosen.range)) close();
      }
    }
  }
  function renderKnowledge() {
    const card = currentCard;
    meta.textContent = [card.phonetic, card.partOfSpeech].filter(Boolean).join(' · ');
    knowledge.replaceChildren(); credit.replaceChildren();
    if (card.meaning && card.meaning !== card.translation) knowledge.appendChild(make('p', 'ezr-word-meaning', card.meaning));
    if (card.usage) {
      const usage = make('div', 'ezr-word-usage');
      usage.append(make('span', 'ezr-word-caption', '用法'), make('p', '', card.usage));
      knowledge.appendChild(usage);
    }
    if (card.example) {
      const example = make('div', 'ezr-word-example');
      example.append(make('span', 'ezr-word-caption', '例句'), make('p', '', card.example));
      if (card.exampleTranslation) example.appendChild(make('p', 'ezr-word-example-translation', card.exampleTranslation));
      knowledge.appendChild(example);
    }
    if (card.provider === 'dictionary') {
      const link = make('a', '', '词典来源');
      link.href = card.dictionaryUrl || 'https://dictionaryapi.dev/'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      credit.appendChild(link);
      if (card.license) credit.appendChild(doc.createTextNode(` · ${card.license}`));
    } else if (card.provider === 'ai') credit.textContent = 'AI 生成 · 根据当前语境';
  }
  async function expandCard(chosen, token) {
    if (!currentCard || !lastTranslation || !prefs.explanations) return;
    learningBusy = true; retryScope = 'word'; controls();
    save.disabled = exportButton.disabled = true;
    save.textContent = '加入生词本'; retry.hidden = true;
    knowledge.textContent = lastTranslation.provider === 'deepseek' ? '正在生成词语讲解…' : '正在查词典…';
    position(chosen.rect);
    try {
      const response = await request({ type: 'ezr:translation:learn', ...lastTranslation });
      if (!alive(chosen, token)) return;
      if (!response?.ok) throw new Error(response?.message || '词语扩展暂不可用。');
      if (response.available) currentCard = normalizeWordCard({ ...currentCard, ...response.knowledge });
      renderKnowledge();
      if (response.note) detail.textContent = response.note;
    } catch {
      if (!alive(chosen, token)) return;
      renderKnowledge();
      detail.textContent = '扩展暂不可用，译文仍可保存。';
      retry.hidden = false;
    } finally {
      if (alive(chosen, token) && currentCard) {
        learningBusy = false; controls();
        save.disabled = exportButton.disabled = false;
        position(chosen.rect);
      }
    }
    if (alive(chosen, token) && retry.hidden) await autoSave(chosen, token);
  }
  async function studyWords(chosen, token, wholeArticle) {
    if (prefs.provider !== 'deepseek' || (!prefs.explanations && !prefs.wordCards)) return;
    learningBusy = true; retryScope = wholeArticle ? 'article' : 'selection';
    studyScope = retryScope;
    currentCard = null; vocabulary = []; meta.textContent = credit.textContent = ''; controls();
    save.textContent = '加入这些生词'; save.disabled = exportButton.disabled = true; retry.hidden = true;
    const ir = getDocument();
    label.textContent = wholeArticle ? '本篇生词' : '本段生词';
    panel.classList.remove('is-word-card');
    if (wholeArticle) source.textContent = ir.title || doc.title;
    if (!context) context = sampleContext(ir.blocks.map(block => block.text || '').join('\n\n'));
    knowledge.textContent = `正在按 ${prefs.level} 水平挑选${wholeArticle ? '本篇' : '本段'}生词…`;
    position(chosen.rect);
    try {
      const reply = await request({ type: 'ezr:translation:vocabulary', provider: 'deepseek', text: wholeArticle ? context : chosen.text,
        view: getView() || { id: viewId, context, title: ir.title || doc.title, language: doc.documentElement.lang } });
      if (!alive(chosen, token)) return;
      if (!reply?.ok) throw new Error(reply?.message || '生词挑选暂不可用。');
      vocabulary = (reply.words || []).map(word => normalizeWordCard({ ...word, pageUrl: chosen.url, pageTitle: ir.title || doc.title }));
      knowledge.replaceChildren();
      knowledge.appendChild(make('p', 'ezr-vocabulary-heading', `${reply.level || prefs.level} · ${wholeArticle ? '本篇' : '本段'}生词`));
      if (!vocabulary.length) knowledge.appendChild(make('p', '', '没有找到适合当前水平的新词，可调整英语水平。'));
      for (const word of vocabulary) {
        const item = make('details', 'ezr-vocabulary-word');
        const heading = make('summary', '');
        heading.append(make('strong', '', word.term), make('span', '', word.translation)); item.appendChild(heading);
        if (prefs.explanations) {
          if (word.meaning) item.appendChild(make('p', 'ezr-word-meaning', word.meaning));
          if (word.usage) item.appendChild(make('p', 'ezr-word-usage', word.usage));
          if (word.example) { const example = make('div', 'ezr-word-example', word.example); if (word.exampleTranslation) example.appendChild(make('p', 'ezr-word-example-translation', word.exampleTranslation)); item.appendChild(example); }
        }
        if (word.sourceSentence) item.appendChild(make('p', 'ezr-word-example-translation', `原句：${word.sourceSentence}`));
        knowledge.appendChild(item);
      }
      credit.textContent = wholeArticle ? 'AI 按水平挑选 · 基于当前阅读内容节选' : 'AI 按水平挑选 · 仅含本次选文中的词语';
    } catch (error) {
      if (!alive(chosen, token)) return;
      knowledge.textContent = error.message; retry.hidden = false;
    } finally {
      if (alive(chosen, token)) { learningBusy = false; controls(); save.disabled = exportButton.disabled = false; position(chosen.rect); }
    }
    if (alive(chosen, token) && retry.hidden) { await autoSave(chosen, token); if (exportable().length) onCards(exportable(), chosen.range); }
  }
  async function saveCards(automatic = false, token = serial) {
    const cards = exportable(), chosen = selected;
    if (!cards.length || !chosen || !alive(chosen, token) || learningBusy) return;
    if (automatic && (!prefs.autoSave || !prefs.wordCards)) return;
    save.disabled = true;
    try {
      const response = await request({ type: 'ezr:translation:cards-save-many', cards, automatic });
      if (!alive(chosen, token)) return;
      if (!response?.ok) throw new Error(response?.message || '保存失败，请重试。');
      if (response.skipped) { save.disabled = false; return; }
      save.textContent = automatic ? '已自动加入' : '已加入';
      detail.textContent = `生词本 ${response.count} 张 · 在翻译设置中批量导出`;
    } catch (error) { if (alive(chosen, token)) { detail.textContent = error.message; save.disabled = false; } }
  }
  async function autoSave(chosen, token) { if (alive(chosen, token) && prefs.autoSave && prefs.wordCards) await saveCards(true, token); }
  function reset() { close(); dismissed = ''; context = ''; viewId = crypto.randomUUID(); clearRemote(); }
  async function loadConfig() {
    const revision = ++configRevision;
    try {
      const result = await request({ type: 'ezr:translation:config' });
      if (!result?.ok || destroyed || pendingPreferences || revision !== configRevision) return;
      const next = normalizeTranslation(result.config), wasReady = ready;
      const changed = JSON.stringify(next) !== JSON.stringify(prefs);
      if (translationContextKey(prefs) !== translationContextKey(next)) reset();
      else if (wasReady && changed) close();
      prefs = next; ready = true; controls();
      if (!prefs.enabled) close();
      else if (!wasReady && selected) schedulePreload();
    } catch { /* The translate button displays actionable errors if the worker is unavailable. */ }
  }
  const changed = (changes, area) => { if (area === 'local' && changes[TRANSLATION_KEY] && !pendingPreferences) void loadConfig(); };
  if (typeof chrome !== 'undefined') chrome.storage?.onChanged?.addListener(changed);
  closeButton.addEventListener('click', close);
  async function chooseProvider(provider) {
    clearTimeout(preloadTimer);
    serial++;
    const chosen = selected, revision = ++preferenceRevision;
    prefs = { ...prefs, provider }; controls(); pendingPreferences++;
    free.disabled = deepseek.disabled = true;
    let saved = false;
    try {
      const reply = await request({ type: 'ezr:translation:preferences', patch: { provider } });
      if (!reply?.ok) throw new Error(reply?.message || '服务切换失败。');
      saved = true;
    } catch (error) { detail.textContent = error.message; }
    finally { pendingPreferences--; if (!pendingPreferences) void loadConfig(); }
    if (saved && !destroyed && revision === preferenceRevision && selected === chosen) await run(provider);
    else if (!destroyed && revision === preferenceRevision) free.disabled = deepseek.disabled = false;
  }
  free.addEventListener('click', () => { void chooseProvider('free'); });
  deepseek.addEventListener('click', () => { void chooseProvider('deepseek'); });
  level.addEventListener('change', () => { void changePreferences({ level: level.value }); });
  study.addEventListener('click', () => {
    if (selected) { clearTimeout(preloadTimer); free.disabled = deepseek.disabled = false; void studyWords(selected, ++serial, true); }
  });
  retry.addEventListener('click', () => {
    if (!selected) return;
    if (retryScope === 'word') void expandCard(selected, serial);
    else void studyWords(selected, ++serial, retryScope === 'article');
  });
  save.addEventListener('click', () => { void saveCards(); });
  exportButton.addEventListener('click', () => {
    if (!exportable().length || selected?.url !== doc.location.href || learningBusy) return;
    downloadWordCards(exportable(), 'anki', doc);
    detail.textContent = '在 Anki 中导入文件，选择双面（Basic）笔记类型。';
  });
  options.addEventListener('click', () => { void request({ type: 'ezr:translation:options' }).catch(() => {}); });
  panel.addEventListener('toggle', () => { if (selected && !panel.hidden) position(selected.rect); }, { capture: true, signal: abort.signal });
  article.addEventListener('pointerdown', event => { if (event.composedPath().includes(panel)) return; selecting = true; dismissed = ''; close(); dismissed = ''; }, { signal: abort.signal });
  doc.addEventListener('pointerup', () => { if (selecting) { selecting = false; clearTimeout(selectionTimer); selectionTimer = setTimeout(capture, 20); } }, { signal: abort.signal });
  article.addEventListener('pointerup', () => { selecting = false; clearTimeout(selectionTimer); selectionTimer = setTimeout(capture, 20); }, { signal: abort.signal });
  doc.addEventListener('selectionchange', () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(capture, 180);
  }, { signal: abort.signal });
  doc.addEventListener('pointerdown', event => {
    if (!event.composedPath().includes(panel) && !event.composedPath().includes(article)) close();
  }, { capture: true, signal: abort.signal });
  doc.defaultView.addEventListener('resize', close, { signal: abort.signal });
  article.parentElement.addEventListener('scroll', close, { passive: true, signal: abort.signal });
  void loadConfig();
  return { close, reset, get isOpen() { return !panel.hidden; }, destroy() {
    destroyed = true; close(); abort.abort(); clearTimeout(selectionTimer); panel.remove(); clearRemote();
    if (typeof chrome !== 'undefined') chrome.storage?.onChanged?.removeListener(changed);
  } };
}
