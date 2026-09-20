/** Pure card schema and interoperable exports. All provider text remains untrusted. */
export const WORDBOOK_KEY = 'ezr:wordbook';
export const WORDBOOK_LIMIT = 500;
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max) : '';

export function isWordSelection(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length > 0 && text.length <= 64 && text.split(/\s+/).length <= 5
    && /^[\p{L}\p{M}][\p{L}\p{M}\s'’\-]*$/u.test(text)
    && (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) || text.length <= 16);
}
export function safeSourceUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href.slice(0, 1800) : ''; }
  catch { return ''; }
}
export function normalizeWordCard(raw = {}) {
  const term = clean(raw.term, 64), translation = clean(raw.translation, 240);
  if (!isWordSelection(term) || !translation) throw new Error('请选择词语或短语生成单词卡。');
  return {
    term, translation, phonetic: clean(raw.phonetic, 60), partOfSpeech: clean(raw.partOfSpeech, 32),
    meaning: clean(raw.meaning, 180), usage: clean(raw.usage, 140),
    example: clean(raw.example, 200), exampleTranslation: clean(raw.exampleTranslation, 180),
    provider: raw.provider === 'ai' ? 'ai' : raw.provider === 'dictionary' ? 'dictionary' : 'translation',
    level: /^[ABC][12]$/.test(raw.level || '') ? raw.level : '',
    sourceLanguage: clean(raw.sourceLanguage, 12).toLowerCase().replace(/^(en|fr|de|es|it|pt|ru|ja|ko)-.*$/, '$1'),
    targetLanguage: clean(raw.targetLanguage, 12).toLowerCase(),
    sourceSentence: clean(raw.sourceSentence, 280), pageTitle: clean(raw.pageTitle, 160), pageUrl: safeSourceUrl(raw.pageUrl),
    dictionaryUrl: safeSourceUrl(raw.dictionaryUrl), license: clean(raw.license, 80), licenseUrl: safeSourceUrl(raw.licenseUrl),
  };
}
export function cardIdentity(raw) {
  const card = normalizeWordCard(raw);
  return JSON.stringify([card.term.normalize('NFKC').toLocaleLowerCase('en'), card.sourceLanguage, card.targetLanguage]);
}
export function normalizeAiKnowledge(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value.meaning !== 'string' || !value.meaning.trim()) throw new Error('词语讲解格式无效，请重试。');
  return {
    phonetic: clean(value.phonetic, 60), partOfSpeech: clean(value.partOfSpeech, 32),
    meaning: clean(value.meaning, 180), usage: clean(value.usage, 140),
    example: clean(value.example, 200), exampleTranslation: clean(value.exampleTranslation, 180), provider: 'ai',
  };
}
const html = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/[\t\r\n]+/g, ' ');
const oneLine = value => String(value || '').replace(/[\t\r\n]+/g, ' ').trim();
function backLines(card) {
  return [card.translation, [card.phonetic, card.partOfSpeech].filter(Boolean).join(' · '),
    card.meaning, card.usage, card.level && `学习水平：${card.level}`, card.example && `例句：${card.example}`,
    card.exampleTranslation, card.sourceSentence && `原句：${card.sourceSentence}`,
    card.pageTitle && `阅读来源：${card.pageTitle}`, card.pageUrl,
    card.provider === 'ai' ? `${card.meaning || card.usage || card.example ? '词语讲解' : '词语译法'}：DeepSeek AI 生成` : card.provider === 'dictionary' ? '词语讲解：词典摘录（含转译）' : '',
    card.dictionaryUrl, card.license && `词典许可：${card.license}`, card.licenseUrl].filter(Boolean);
}
export function exportWordCards(cards, format = 'anki') {
  if (!Array.isArray(cards) || !cards.length) throw new Error('还没有可导出的单词卡。');
  if (!['anki', 'tsv'].includes(format)) throw new Error('不支持的导出格式。');
  const normalized = cards.map(normalizeWordCard);
  const lines = normalized.map(card => {
    if (format === 'tsv') return `${oneLine(card.term)}\t释义：${backLines(card).map(oneLine).join(' ｜ ')}`;
    return `${html(card.term)}\t${backLines(card).map((line, index) => index === 0 ? `<b>${html(line)}</b>` : html(line)).join('<br>')}`;
  });
  const header = format === 'anki' ? '#separator:Tab\n#html:true\n#columns:Front\tBack\n#tags:EZReader\n' : '';
  return { filename: format === 'anki' ? 'ez-reader-anki.txt' : 'ez-reader-words.tsv',
    mime: 'text/plain;charset=utf-8', text: header + lines.join('\n') + '\n' };
}
