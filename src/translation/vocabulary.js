import { normalizeWordCard, isWordSelection } from './word-card.js';

export const MAX_VOCABULARY_WORDS = 6;
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ground each generated word and its saved sentence in the supplied article/selection. */
export function normalizeVocabulary(raw, text, { target, level, explanations = true }) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data?.words)) throw new Error('AI 生词列表格式无效，请重试。');
  const words = [], seen = new Set();
  for (const item of data.words.slice(0, 30)) {
    if (!item || !isWordSelection(item.term) || !/^[a-z][a-z\s'’-]*$/i.test(item.term) || typeof item.translation !== 'string' || !item.translation.trim()) continue;
    const term = item.term.trim().replace(/\s+/g, ' ');
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${term.split(' ').map(escapeRegex).join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
    if (!match || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const before = text.slice(0, match.index), tail = text.slice(match.index);
    const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1;
    const end = tail.search(/[.!?\n]/);
    const sentence = text.slice(Math.max(start, match.index - 100), match.index + (end >= 0 ? end + 1 : 180)).trim();
    const fields = explanations ? item : { term: item.term, translation: item.translation };
    words.push(normalizeWordCard({ ...fields, term: match[0].replace(/\s+/g, ' '), provider: 'ai', level,
      sourceLanguage: 'en', targetLanguage: target, sourceSentence: sentence, pageUrl: '', dictionaryUrl: '', license: '', licenseUrl: '' }));
    if (words.length === MAX_VOCABULARY_WORDS) break;
  }
  return words;
}
