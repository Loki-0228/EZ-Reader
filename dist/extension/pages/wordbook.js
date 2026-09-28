import { downloadWordCards } from '../translation/card-download.js';
import { WORDBOOK_KEY } from '../translation/word-card.js';

const byId = id => document.getElementById(id);
let cards = [], revision = 0;
const status = byId('wordbook-status');
const call = async message => {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.message || '生词本暂不可用。');
  return reply;
};
function render() {
  byId('wordbook-count').textContent = `${cards.length} 张`;
  byId('wordbook-export').disabled = byId('wordbook-tsv').disabled = cards.length === 0;
  const query = byId('wordbook-search').value.trim().toLocaleLowerCase();
  const matches = cards.filter(card => `${card.term} ${card.translation}`.toLocaleLowerCase().includes(query));
  const list = byId('wordbook-list');
  list.replaceChildren();
  for (const card of matches.slice(0, 30)) {
    const row = document.createElement('div'); row.className = 'wordbook-row';
    const text = document.createElement('div');
    const term = document.createElement('strong'); term.textContent = card.term;
    const meaning = document.createElement('span'); meaning.textContent = card.translation;
    text.append(term, meaning);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '移除'; remove.className = 'button';
    remove.setAttribute('aria-label', `移除 ${card.term}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { await call({ type: 'ezr:translation:cards-remove', id: card.id }); await load(); }
      catch (error) { status.textContent = error.message; remove.disabled = false; }
    });
    row.append(text, remove); list.appendChild(row);
  }
  status.textContent = !cards.length ? '划词翻译后点击“加入生词本”，再来这里批量导出。'
    : !matches.length ? '没有匹配的词语。' : matches.length > 30 ? `显示前 30 张，导出包含全部 ${cards.length} 张。` : '保存在本机；同一词语与语言组合再次保存会更新内容。';
}
async function load() {
  const token = ++revision;
  try {
    const result = await call({ type: 'ezr:translation:cards-list' });
    if (token !== revision) return;
    cards = result.cards; render();
  } catch (error) { status.textContent = error.message; }
}
byId('wordbook-export').addEventListener('click', () => downloadWordCards(cards, 'anki'));
byId('wordbook-tsv').addEventListener('click', () => downloadWordCards(cards, 'tsv'));
byId('wordbook-search').addEventListener('input', render);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[WORDBOOK_KEY]) void load(); });
void load();
