import { downloadWordCards } from '../translation/card-download.js';

/** Notes consume existing cards; rendering or scrolling never calls a translation API. */
export function createTranslationNotes({ root, article, request, doc }) {
  const layer = doc.createElement('aside'); layer.className = 'ezr-translation-notes'; layer.setAttribute('aria-label', '生词批注'); root.appendChild(layer);
  const entries = new Map(), abort = new AbortController();
  const scroller = article.parentElement;
  let frame = 0;
  const make = (tag, text, cls = '') => { const element = doc.createElement(tag); element.textContent = text; element.className = cls; return element; };
  function layout() {
    frame = 0;
    const viewport = scroller.getBoundingClientRect(), wide = doc.documentElement.clientWidth >= 1100;
    const bottoms = [viewport.top + 12, viewport.top + 12];
    [...entries.values()].forEach((entry, index, all) => {
      let rect;
      try { rect = entry.range.getBoundingClientRect(); } catch { entry.element.hidden = true; return; }
      const side = index % 2;
      entry.element.hidden = !entry.range.startContainer.isConnected || rect.bottom < viewport.top || rect.top > viewport.bottom || (!wide && index !== all.length - 1);
      if (entry.element.hidden) return;
      const top = wide ? Math.max(viewport.top + 12, rect.top, bottoms[side]) : Math.max(viewport.top, innerHeight - 246);
      entry.element.style.top = `${top}px`;
      entry.element.style.left = wide ? (side ? `${viewport.right + 12}px` : '12px') : '10px';
      entry.element.style.width = wide ? '196px' : `${doc.documentElement.clientWidth - 20}px`;
      entry.element.style.maxHeight = `${wide ? Math.max(70, Math.min(228, viewport.bottom - top - 10)) : 228}px`;
      entry.element.dataset.side = side ? 'right' : 'left';
      if (wide && top + 70 > viewport.bottom) entry.element.hidden = true;
      bottoms[side] = top + entry.element.offsetHeight + 12;
    });
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(layout); }
  function clear() { entries.clear(); layer.replaceChildren(); scroller.classList.remove('ezr-has-notes'); }
  function add(cards, range) {
    const anchor = range.startContainer.parentElement?.closest('[data-ezr-id]');
    for (const card of cards) {
      const key = `${anchor?.dataset.ezrId || ''}:${card.term}:${card.targetLanguage}`;
      entries.get(key)?.element.remove();
      const element = make('section', '', 'ezr-translation-note');
      const head = make('div', '', 'ezr-note-head'), remove = make('button', '×', 'ezr-note-close'); remove.type = 'button'; remove.setAttribute('aria-label', '移除生词批注');
      head.append(make('strong', card.term), remove); element.append(head, make('p', card.translation, 'ezr-note-translation'));
      for (const text of [card.meaning !== card.translation ? card.meaning : '', card.usage, card.example, card.exampleTranslation]) if (text) element.appendChild(make('p', text));
      const footer = make('div', '', 'ezr-note-actions'), save = make('button', '加入生词本'), download = make('button', 'Anki');
      save.type = download.type = 'button'; footer.append(save, download); element.appendChild(footer);
      const attribution = make('small', card.provider === 'dictionary' ? `词典 · ${card.license || ''}` : `AI 生成 · ${card.level || '当前语境'} 水平`);
      element.appendChild(attribution);
      remove.addEventListener('click', () => { element.remove(); entries.delete(key); if (!entries.size) scroller.classList.remove('ezr-has-notes'); schedule(); });
      save.addEventListener('click', async () => {
        save.disabled = true;
        try { const response = await request({ type: 'ezr:translation:cards-save', card }); if (!response?.ok) throw new Error(response?.message || '保存失败'); save.textContent = '已加入'; }
        catch (error) { save.disabled = false; attribution.textContent = error.message; }
      });
      download.addEventListener('click', () => downloadWordCards([card], 'anki', doc));
      entries.set(key, { element, range: range.cloneRange() }); layer.appendChild(element);
    }
    // Notes are a reading aid, not a second persistent wordbook.
    while (entries.size > 24) { const key = entries.keys().next().value; entries.get(key).element.remove(); entries.delete(key); }
    scroller.classList.toggle('ezr-has-notes', entries.size > 0); schedule();
    return true;
  }
  scroller.addEventListener('scroll', schedule, { passive: true, signal: abort.signal });
  doc.defaultView.addEventListener('resize', schedule, { signal: abort.signal });
  const observer = new ResizeObserver(schedule); observer.observe(scroller); observer.observe(layer);
  return { add, clear, destroy() { clear(); abort.abort(); observer.disconnect(); cancelAnimationFrame(frame); layer.remove(); } };
}
