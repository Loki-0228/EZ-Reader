/** English dictionary adapter; no generated definitions or invented examples. */
const STOP = new Set('a an the and or of to in on for is are was were be this that it with by as'.split(' '));
const words = text => String(text).toLowerCase().match(/[a-z]{3,}/g)?.filter(word => !STOP.has(word)) || [];
const posNames = { noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词', pronoun: '代词',
  preposition: '介词', conjunction: '连词', interjection: '感叹词', exclamation: '感叹词' };
const array = value => Array.isArray(value) ? value : [];

/** REST definitions contain markup. Convert to text, never insert remote HTML into a page. */
function plain(value) {
  return String(value || '').slice(0, 12000).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (!entity.startsWith('#')) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[entity.toLowerCase()];
      const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }).replace(/\s+/g, ' ').trim();
}
export function wiktionaryEntries(data, term) {
  return [{ sourceUrls: [`https://en.wiktionary.org/wiki/${encodeURIComponent(term)}`],
    license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    meanings: array(data?.en).slice(0, 12).map(meaning => ({
      partOfSpeech: plain(meaning.partOfSpeech).toLowerCase(),
      definitions: array(meaning.definitions).slice(0, 30).map(item => ({
        definition: plain(item.definition), example: plain(item.parsedExamples?.[0]?.example || item.examples?.[0]),
      })).filter(item => item.definition),
    })),
  }];
}

export function dictionaryEntry(data, nearby = '', term = '') {
  if (!Array.isArray(data)) return null;
  const queryWords = new Set(words(term));
  const context = new Set(words(nearby).filter(word => !queryWords.has(word)));
  const candidates = [];
  for (const entry of data.slice(0, 5)) {
    for (const meaning of array(entry?.meanings).slice(0, 12)) {
      for (const definition of array(meaning?.definitions).slice(0, 30)) {
        if (typeof definition?.definition !== 'string' || !definition.definition.trim()) continue;
        const score = [...new Set(words(`${definition.definition} ${definition.example || ''}`))].filter(word => context.has(word)).length;
        candidates.push({ entry, meaning, definition, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const found = candidates[0];
  if (!found) return null;
  const { entry, meaning, definition } = found;
  return {
    phonetic: entry.phonetic || array(entry.phonetics).find(item => item?.text)?.text || '',
    partOfSpeech: posNames[meaning.partOfSpeech] || meaning.partOfSpeech || '',
    definition: definition.definition.slice(0, 300), example: String(definition.example || '').slice(0, 200),
    dictionaryUrl: entry.sourceUrls?.[0] || 'https://dictionaryapi.dev/',
    license: entry.license?.name || '', licenseUrl: entry.license?.url || '',
  };
}
