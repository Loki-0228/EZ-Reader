import { WORDBOOK_KEY, normalizeWordCard } from '../translation/word-card.js';
import { downloadWordCards } from '../translation/card-download.js';
import { readUserSelection } from '../dom/user-selection.js';
import { closeIcon } from './close-icon.js';

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const bubbleKey = card => JSON.stringify([card.term.normalize('NFKC').toLowerCase(), card.targetLanguage.toLowerCase()]);
export function termMatch(text, term) {
  if (!term?.trim()) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${term.trim().split(/\s+/).map(escape).join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
}
function matchDisplayed(text, term) {
  // CJK translations do not have whitespace word boundaries.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term || '')) {
    const index = text.indexOf(term); return index < 0 ? null : { index, 0:term };
  }
  return termMatch(text, term);
}

const CSS = `
.ezr-bubbles{position:fixed;inset:0;pointer-events:none;z-index:60;color:var(--ezr-fg)}
.ezr-bubbles [hidden]{display:none!important}
.ezr-bubble-dot{position:fixed;width:24px;height:24px;padding:0;border:0;background:transparent;cursor:pointer;pointer-events:auto;border-radius:50%}
.ezr-bubble-dot::before{content:'';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);box-sizing:border-box;width:8px;height:8px;border:1px solid #125b32;border-radius:50%;background:#21804c;opacity:.7}
.ezr-bubble-dot[data-saved=true]::before{background:#ba8a08;border-color:#765500}
.ezr-bubble-dot:hover::before,.ezr-bubble-dot[aria-expanded=true]::before{width:10px;height:10px}
.ezr-bubbles :is(button,a):focus-visible{outline:2px solid var(--ezr-accent);outline-offset:2px}
.ezr-bubble-card{position:fixed;box-sizing:border-box;pointer-events:auto;background:var(--ezr-bg);color:var(--ezr-fg);border-radius:12px;padding:18px;box-shadow:0 6px 24px #0003;font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif;overflow:auto;overflow-wrap:anywhere;text-transform:none;user-select:text}
.ezr-bubble-glint{position:relative;flex:none;width:16px;height:16px;margin:2px 1px 0;background:linear-gradient(135deg,#fff8c9 0 30%,#ffd451 31% 100%);clip-path:polygon(50% 0,61% 36%,100% 50%,61% 64%,50% 100%,39% 64%,0 50%,39% 36%);filter:drop-shadow(0 1px 2px #d99c2877)}
.ezr-bubble-glint::after{content:'';position:absolute;top:0;right:0;width:5px;height:5px;border-radius:50%;background:#fff}
.ezr-bubble-head,.ezr-bubble-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ezr-bubble-head{flex-wrap:nowrap;align-items:start}
.ezr-bubble-head strong{font-size:22px;line-height:1.3;flex:1;min-width:0}
.ezr-bubble-card button{font:inherit;color:inherit;background:var(--ezr-bg);border:1px solid var(--ezr-border);border-radius:6px;padding:5px 9px;cursor:pointer}
.ezr-bubble-head button{flex:none;width:28px;height:28px;padding:4px;border:0}
.ezr-bubble-head svg{width:18px;height:18px}
.ezr-bubble-card button:disabled{opacity:.65;cursor:default}
.ezr-bubble-translation{font-size:18px;font-weight:600;margin:12px 0 8px}
.ezr-bubble-card p{margin:8px 0}
.ezr-bubble-meta,.ezr-bubble-status{color:var(--ezr-muted);font-size:12px}
.ezr-bubble-actions{margin-top:16px}
.ezr-bubble-card a{color:var(--ezr-accent)}
.ezr-bubble-all{position:fixed;box-sizing:border-box;right:10px;width:min(760px,calc(100vw - 20px));overflow:auto;pointer-events:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:12px;padding:8px;border:1px solid var(--ezr-border);border-radius:14px;background:var(--ezr-bg);box-shadow:0 6px 24px #0003;overscroll-behavior:contain}
.ezr-bubble-all .ezr-bubble-card{position:relative;border:1px solid var(--ezr-border);box-shadow:none;min-width:0;overflow:visible}
@media(forced-colors:active){.ezr-bubble-dot::before{background:ButtonText;outline:1px solid Canvas;opacity:1}.ezr-bubble-dot[data-saved=true]::before{border-radius:0}.ezr-bubble-card{border:1px solid CanvasText}}
`;

/** Page-local cards never issue translation requests. Only an explicit save writes the wordbook. */
export function createBubbleCards({ root, article, doc, request, state, getSources }) {
  const make = (tag, cls, text = '') => { const node = doc.createElement(tag); node.className = cls; node.textContent = text; return node; };
  const style = make('style', 'ezr-bubble-style', CSS), layer = make('aside', 'ezr-bubbles');
  layer.setAttribute('aria-label', '泡泡词卡'); root.append(style, layer);
  const panel = make('section', 'ezr-bubble-card'); panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '泡泡词卡');
  layer.appendChild(panel);
  const allPanel = make('section', 'ezr-bubble-all'); allPanel.hidden = true; allPanel.setAttribute('aria-label', '全部泡泡词卡'); layer.appendChild(allPanel);
  const folded = new Set();
  let focusId;
  const abort = new AbortController(), scroller = article.parentElement;
  const measure = doc.createElement('canvas').getContext('2d'), metricsCache = new Map();
  const segmenter = new Intl.Segmenter(undefined, { granularity:'grapheme' });
  let settings = { active:false }, saved = [], entries = [], opened = null, frame = 0, rebuild = false, destroyed = false, selectionTimer;
  function minimize(focus = false) {
    const previous = opened || entries.find(entry => entry.id === focusId); opened = null; panel.hidden = true;
    allPanel.hidden = true; allPanel.replaceChildren(); folded.clear();
    for (const entry of entries) entry.button.setAttribute('aria-expanded', 'false');
    if (focus) previous?.button.focus({ preventScroll:true });
  }
  function contentViewport() {
    if (!settings.original) return scroller.getBoundingClientRect();
    let top = 0, bottom = doc.defaultView.innerHeight;
    const topBar = root.querySelector('.ezr-toolbar-slot-top')?.getBoundingClientRect();
    const bottomBar = root.querySelector('.ezr-toolbar-slot-bottom')?.getBoundingClientRect();
    if (topBar?.height) top = Math.max(top, topBar.bottom);
    if (bottomBar?.height) bottom = Math.min(bottom, bottomBar.top);
    const pdfTools = doc.getElementById('pdf-navigation')?.getBoundingClientRect();
    if (pdfTools?.height) top = Math.max(top, pdfTools.bottom);
    return { top, bottom, left:0, right:doc.documentElement.clientWidth };
  }
  function position() {
    if (!allPanel.hidden) {
      const viewport = contentViewport();
      allPanel.style.width = `${Math.min(760, doc.documentElement.clientWidth - 20)}px`;
      allPanel.style.top = `${viewport.top + 10}px`; allPanel.style.maxHeight = `${Math.max(60, viewport.bottom - viewport.top - 20)}px`;
    }
    if (!opened) return;
    const rect = opened.range.getBoundingClientRect(), width = Math.min(360, doc.documentElement.clientWidth - 20), viewport = contentViewport();
    panel.style.width = `${width}px`; panel.style.maxHeight = `${Math.max(60, viewport.bottom - viewport.top - 24)}px`;
    panel.style.left = `${Math.max(10, Math.min(rect.left, doc.documentElement.clientWidth - width - 10))}px`;
    const height = panel.offsetHeight;
    const top = rect.bottom + 10;
    panel.style.top = `${top + height > viewport.bottom - 10 ? Math.max(viewport.top + 10, rect.top - height - 10) : top}px`;
  }
  function open(entry, focus = false) {
    minimize(); opened = entry; focusId = entry.id; panel.replaceChildren(); panel.hidden = false;
    entry.button.setAttribute('aria-expanded', 'true');
    renderCard(entry, panel);
    position(); if (focus) panel.querySelector('.ezr-bubble-minimize').focus({ preventScroll:true });
  }
  function expandAll(keepFolded = false, focus = false) {
    const previousFolded = keepFolded ? [...folded] : [];
    minimize(); for (const key of previousFolded) folded.add(key);
    const unique = new Map(entries.filter(entry => !folded.has(bubbleKey(entry.card))).map(entry => [bubbleKey(entry.card), entry]));
    for (const entry of unique.values()) { const cardPanel = make('section', 'ezr-bubble-card'); renderCard(entry, cardPanel); allPanel.appendChild(cardPanel); }
    allPanel.hidden = !unique.size;
    for (const entry of entries) entry.button.setAttribute('aria-expanded', String(unique.has(bubbleKey(entry.card))));
    position(); if (focus) allPanel.querySelector('.ezr-bubble-collapse-all')?.focus({ preventScroll:true });
  }
  function renderCard(entry, panel) {
    const card = entry.card, key = bubbleKey(card), head = make('div', 'ezr-bubble-head');
    const min = make('button', 'ezr-bubble-minimize'), close = make('button', 'ezr-bubble-close');
    for (const button of [min, close]) button.type = 'button';
    min.setAttribute('aria-label', '最小化为圆点'); min.title = '最小化为圆点';
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const line = doc.createElementNS(svg.namespaceURI, 'path'); line.setAttribute('d', 'M5 12h14'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '2'); svg.append(line); min.append(svg);
    close.setAttribute('aria-label', '关闭此词卡，本篇不再显示'); close.title = '关闭此词卡，本篇不再显示'; close.append(closeIcon(doc));
    const glint = make('span', 'ezr-bubble-glint'); glint.setAttribute('aria-hidden', 'true');
    head.append(make('strong', '', card.term), glint, min, close); panel.append(head);
    panel.append(make('p', 'ezr-bubble-meta', [card.phonetic, card.partOfSpeech].filter(Boolean).join(' · ')), make('p', 'ezr-bubble-translation', card.translation));
    for (const text of [card.meaning !== card.translation ? card.meaning : '', card.usage, card.example, card.exampleTranslation]) if (text) panel.append(make('p', '', text));
    const info = make('p', 'ezr-bubble-status', entry.saved ? '已在生词本 · 黄点' : '本篇已缓存 · 绿点'); info.setAttribute('role', 'status');
    const footer = make('div', 'ezr-bubble-actions'), save = make('button', 'ezr-bubble-save', entry.saved ? '已加入生词本' : '加入生词本'), download = make('button', '', '导出 Anki');
    const expand = make('button', 'ezr-bubble-expand-all', '全部展开'), collapse = make('button', 'ezr-bubble-collapse-all', '全部收起');
    save.type = download.type = expand.type = collapse.type = 'button'; save.disabled = entry.saved;
    footer.append(save, download, expand, collapse); panel.append(footer, info);
    expand.addEventListener('click', () => expandAll(false, true));
    collapse.addEventListener('click', () => minimize(true));
    if (card.provider === 'dictionary' && card.dictionaryUrl) {
      const source = make('a', 'ezr-bubble-meta', `词典来源${card.license ? ' · ' + card.license : ''}`); source.href = card.dictionaryUrl; source.target = '_blank'; source.rel = 'noopener noreferrer'; panel.append(source);
    } else if (card.provider === 'ai') panel.append(make('p', 'ezr-bubble-meta', `AI 生成 · ${card.level || '当前语境'}`));
    min.addEventListener('click', () => {
      if (allPanel.hidden) minimize(true);
      else { folded.add(key); expandAll(true); entry.button.focus({ preventScroll:true }); }
    });
    close.addEventListener('click', () => { state.closed.add(key); state.cards.delete(key); if (allPanel.hidden) minimize(); schedule(true); });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const reply = await request({ type:'ezr:translation:cards-save', card });
        if (!reply?.ok) throw new Error(reply?.message || '保存失败，请重试。');
        if (destroyed) return;
        saved = [...saved.filter(item => bubbleKey(item) !== key), card];
        for (const item of entries) if (bubbleKey(item.card) === key) { item.saved = true; updateDot(item); }
        save.textContent = '已加入生词本'; info.textContent = '已在生词本 · 黄点';
      } catch (error) { if (!destroyed) { save.disabled = false; info.textContent = error.message; } }
    });
    download.addEventListener('click', () => downloadWordCards([card], 'anki', doc));
  }
  function updateDot(entry) {
    entry.button.dataset.saved = String(entry.saved);
    entry.button.title = `${entry.card.term}：${entry.card.translation}`;
    entry.button.setAttribute('aria-label', `${entry.button.title}，${entry.saved ? '已在生词本，黄点' : '已缓存词卡，绿点'}，打开词卡`);
  }
  function rangeOf(nodes, match) {
    const range = doc.createRange(); let offset = 0, start = false;
    for (const node of nodes) {
      const end = offset + node.data.length;
      if (!start && match.index < end) { range.setStart(node, match.index - offset); start = true; }
      if (start && match.index + match[0].length <= end) { range.setEnd(node, match.index + match[0].length - offset); return range; }
      offset = end;
    }
    return null;
  }
  function endGlyph(range) {
    const glyph = range.cloneRange(), node = range.endContainer;
    const last = [...segmenter.segment(node.data.slice(0, range.endOffset))].at(-1);
    if (last) glyph.setStart(node, last.index);
    return glyph;
  }
  function markerCorner(entry, rect) {
    const glyph = entry.glyph, box = glyph.getBoundingClientRect();
    const fallback = { right:rect.right, top:rect.top };
    // Keep the visual right edge for RTL/mixed-direction and vertical runs.
    if (!measure || !box.height || Math.abs(box.right - rect.right) > 1) return fallback;
    const style = doc.defaultView.getComputedStyle(glyph.endContainer.parentElement);
    if (!style.writingMode.startsWith('horizontal')) return fallback;
    let text = glyph.toString();
    if (style.textTransform === 'uppercase') text = text.toUpperCase();
    else if (style.textTransform === 'lowercase') text = text.toLowerCase();
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const key = JSON.stringify([font, style.fontStretch, style.fontVariantCaps, text]);
    let metrics = metricsCache.get(key);
    if (!metrics) {
      measure.font = font; measure.fontStretch = style.fontStretch; measure.fontVariantCaps = style.fontVariantCaps;
      metrics = measure.measureText(text); metricsCache.set(key, metrics);
      if (metricsCache.size > 256) metricsCache.delete(metricsCache.keys().next().value);
    }
    const fontHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    const advance = metrics.width + (parseFloat(style.letterSpacing) || 0);
    if (!(fontHeight > 0 && advance > 0 && metrics.actualBoundingBoxAscent > 0)) return fallback;
    // Range rectangles include font padding and the final letter's spacing. Use the
    // glyph's ink bounds instead, scaling them with the DOM for PDF/reader zoom.
    return { right:box.left + metrics.actualBoundingBoxRight * box.width / advance,
      top:box.top + (metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent) * box.height / fontHeight };
  }
  function build() {
    const previousKey = opened?.id, hadFocus = panel.contains(root.getRootNode().activeElement);
    const wasAll = !allPanel.hidden, previousFolded = [...folded], scrollTop = allPanel.scrollTop;
    minimize(); entries.forEach(entry => entry.button.remove()); entries = [];
    if (!settings.active) return;
    const wordbook = new Map(saved.filter(card => card.targetLanguage.toLowerCase() === settings.target.toLowerCase()).map(card => [bubbleKey(card), card]));
    const sources = getSources(), available = new Map([...state.cards, ...wordbook]);
    const normalize = word => ({ ...normalizeWordCard({ ...word, pageUrl:doc.location.href, pageTitle:doc.title }), translatedTerm:word.translatedTerm });
    for (const source of sources) for (const word of source.words || []) {
      try { const card = normalize(word); if (!state.closed.has(bubbleKey(card))) available.set(bubbleKey(card), card); } catch { /* Ignore invalid cards. */ }
    }
    sourceLoop: for (const [index, source] of sources.entries()) {
      const nodes = source.nodes.filter(node => node.isConnected && node.data), text = nodes.map(node => node.data).join('');
      if (!text.trim()) continue;
      const cards = new Map(available);
      for (const word of source.words || []) {
        try { const card = normalize(word);
          if (!state.closed.has(bubbleKey(card))) cards.set(bubbleKey(card), card);
        } catch { /* Malformed provider cards must not break translated text. */ }
      }
      const occupied = new Set();
      for (const [key, card] of cards) {
        if (state.closed.has(key) || card.targetLanguage.toLowerCase() !== settings.target.toLowerCase() || !termMatch(source.source, card.term)) continue;
        const match = source.translated ? matchDisplayed(text, card.translatedTerm || card.translation) : termMatch(text, card.term);
        if (!match || occupied.has(match.index)) continue;
        const range = rangeOf(nodes, match); if (!range) continue;
        occupied.add(match.index);
        const button = make('button', 'ezr-bubble-dot'); button.type = 'button'; button.setAttribute('aria-expanded', 'false'); button.dataset.term = card.term;
        const entry = { id:`${index}:${key}`, card, range, glyph:endGlyph(range), button, saved:wordbook.has(key) };
        updateDot(entry); button.addEventListener('click', event => { event.stopPropagation(); open(entry, event.detail === 0); });
        entries.push(entry); layer.insertBefore(button, panel);
        if (entry.id === previousKey) open(entry, hadFocus);
        if (entries.length >= 600) break sourceLoop;
      }
    }
    if (wasAll) { for (const key of previousFolded) folded.add(key); expandAll(true); allPanel.scrollTop = scrollTop; }
  }
  function layout() {
    frame = 0; if (destroyed) return;
    if (rebuild) { rebuild = false; build(); }
    layer.hidden = !settings.active;
    const viewport = contentViewport();
    for (const entry of entries) {
      const rects = entry.range.getClientRects(), rect = rects[rects.length - 1];
      const visible = rect && rect.width > 0 && rect.height > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom && rect.right > viewport.left && rect.left < viewport.right && entry.range.startContainer.isConnected;
      entry.button.hidden = !visible;
      if (visible) {
        const corner = markerCorner(entry, rect);
        entry.button.style.left = `${Math.max(0, Math.min(corner.right - 12, doc.documentElement.clientWidth - 24))}px`;
        entry.button.style.top = `${Math.max(viewport.top, corner.top - 12)}px`;
      } else if (opened === entry) minimize();
    }
    position();
  }
  function schedule(refresh = false) { rebuild ||= refresh; if (!destroyed && !frame) frame = doc.defaultView.requestAnimationFrame(layout); }
  const changed = (changes, area) => {
    if (destroyed || area !== 'local' || !changes[WORDBOOK_KEY]) return;
    saved = (Array.isArray(changes[WORDBOOK_KEY].newValue) ? changes[WORDBOOK_KEY].newValue : []).slice(0, 500).flatMap(raw => { try { return [normalizeWordCard(raw)]; } catch { return []; } });
    schedule(true);
  };
  let bookRevision = 0;
  const bookChanged = (changes, area) => { if (area === 'local' && changes[WORDBOOK_KEY]) { bookRevision++; changed(changes, area); } };
  chrome.storage.onChanged.addListener(bookChanged);
  const initialRevision = bookRevision;
  void chrome.storage.local.get(WORDBOOK_KEY).then(bag => { if (bookRevision === initialRevision) changed({ [WORDBOOK_KEY]:{ newValue:bag[WORDBOOK_KEY] } }, 'local'); }).catch(() => {});
  const observe = new MutationObserver(records => { if (records.some(record => !layer.contains(record.target))) schedule(true); });
  observe.observe(article, { childList:true, subtree:true, characterData:true });
  observe.observe(doc.body, { childList:true, subtree:true, characterData:true });
  const size = new ResizeObserver(() => schedule()); size.observe(scroller);
  doc.fonts?.addEventListener('loadingdone', () => { metricsCache.clear(); schedule(); }, { signal:abort.signal });
  doc.addEventListener('scroll', () => schedule(), { capture:true, passive:true, signal:abort.signal });
  doc.defaultView.addEventListener('resize', () => schedule(), { signal:abort.signal });
  doc.addEventListener('pointerdown', event => { if (allPanel.hidden && !event.composedPath().includes(layer)) minimize(); }, { capture:true, signal:abort.signal });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && (opened || !allPanel.hidden)) { event.stopPropagation(); minimize(true); } }, { capture:true, signal:abort.signal });
  function selection() {
    if (!settings.active || settings.selectionEnabled || root.querySelector('.ezr-settings.is-open')) return;
    const snapshot = readUserSelection({ doc, root:settings.original ? doc.body : article, exclude:layer, domText:true });
    if (!snapshot?.range) return;
    const entry = entries.find(item => item.range.startContainer.isConnected && snapshot.range.intersectsNode(item.range.startContainer)
      && [item.card.term, item.range.toString()].some(term => term.toLowerCase() === snapshot.text.toLowerCase()));
    if (entry) open(entry);
  }
  for (const type of ['selectionchange', 'pointerup', 'keyup']) doc.addEventListener(type, () => { clearTimeout(selectionTimer); selectionTimer = setTimeout(selection, 100); }, { signal:abort.signal });
  return {
    update(next) { settings = next; schedule(true); }, refresh() { schedule(true); }, minimize,
    get isOpen() { return !panel.hidden || !allPanel.hidden; },
    destroy() { destroyed = true; minimize(); abort.abort(); observe.disconnect(); size.disconnect(); clearTimeout(selectionTimer); doc.defaultView.cancelAnimationFrame(frame); chrome.storage.onChanged.removeListener(bookChanged); layer.remove(); style.remove(); },
  };
}
