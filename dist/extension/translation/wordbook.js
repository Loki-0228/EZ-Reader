import { WORDBOOK_KEY, WORDBOOK_LIMIT, normalizeWordCard, cardIdentity } from './word-card.js';

/** Serialize read-modify-write operations so simultaneous saves from two tabs cannot overwrite each other. */
export function createWordbook(storage) {
  let queue = Promise.resolve();
  async function list() {
    const bag = await storage.get(WORDBOOK_KEY);
    return (Array.isArray(bag[WORDBOOK_KEY]) ? bag[WORDBOOK_KEY] : []).slice(0, WORDBOOK_LIMIT).flatMap(item => {
      try { return [{ ...normalizeWordCard(item), id: String(item.id || ''), createdAt: Number(item.createdAt) || 0 }]; }
      catch { return []; }
    });
  }
  const serialize = work => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const saveCards = rawCards => serialize(async () => {
    if (!Array.isArray(rawCards) || !rawCards.length || rawCards.length > 6) throw new Error('一次可保存 1–6 张生词卡。');
    const normalized = rawCards.map(normalizeWordCard), all = await list(), ids = [];
    let updated = false;
    for (const card of normalized) {
      const index = all.findIndex(item => cardIdentity(item) === cardIdentity(card));
      if (index < 0 && all.length >= WORDBOOK_LIMIT) throw new Error('生词本已满（500 张），请先导出并删除部分卡片。');
      const previous = index >= 0 ? all.splice(index, 1)[0] : null;
      const saved = { ...card, id: previous?.id || crypto.randomUUID(), createdAt: previous?.createdAt || Date.now() };
      all.unshift(saved); ids.push(saved.id); updated ||= !!previous;
    }
    await storage.set({ [WORDBOOK_KEY]: all });
    return { id: ids[0], ids, count: all.length, updated };
  });
  return {
    list: () => queue.then(list),
    save: raw => saveCards([raw]),
    saveMany: saveCards,
    remove: id => serialize(async () => {
      const all = await list();
      await storage.set({ [WORDBOOK_KEY]: all.filter(card => card.id !== id) });
    }),
  };
}
