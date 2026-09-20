import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWordSelection, normalizeWordCard, normalizeAiKnowledge, exportWordCards, WORDBOOK_KEY } from '../src/translation/word-card.js';
import { dictionaryEntry, wiktionaryEntries } from '../src/translation/dictionary.js';
import { createWordbook } from '../src/translation/wordbook.js';
import { createTranslationService } from '../src/translation/service.js';

const card = patch => ({ term: 'bank', translation: '银行', sourceLanguage: 'en', targetLanguage: 'zh-CN', ...patch });
const dictionary = [{ phonetic: '/bæŋk/', sourceUrls: ['https://en.wiktionary.org/wiki/bank'],
  license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }, meanings: [{ partOfSpeech: 'noun', definitions: [
    { definition: 'The land alongside a river.', example: 'We sat by the river.' },
    { definition: 'A financial institution that manages deposits and loans.', example: 'The bank approved the loan.' },
  ] }] }];
const input = patch => ({ slot: '1:0', documentId: 'doc', url: 'https://example.com/a',
  view: { id: 'v', context: 'A bank manages financial deposits.', title: 'Finance', language: 'en' },
  text: 'bank', nearby: 'A bank manages financial deposits.', provider: 'free', translation: '银行', sourceLanguage: 'en', ...patch });
const config = { source: 'en', target: 'zh-CN' };
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const wiki = { en: [{ partOfSpeech: 'Noun', definitions: [{ definition: '' },
  { definition: 'A <a href="/wiki/financial">financial</a> institution &amp; lender.', examples: ['The <b>bank</b> approved a loan.'] }] }] };

test('word cards recognize words and short phrases, exclude paragraphs and markup', () => {
  for (const value of ['bank', 'take care of', '你好', 'café', 'well-known']) assert.ok(isWordSelection(value));
  for (const value of ['Hello world.', '<img>', 'one two three four five six', '', '中'.repeat(17)]) assert.equal(isWordSelection(value), false);
});
test('dictionary selects one context-related sense with authentic example and attribution', () => {
  const financial = dictionaryEntry(dictionary, input().nearby, 'bank');
  assert.match(financial.definition, /financial/);
  assert.equal(financial.phonetic, '/bæŋk/');
  assert.equal(financial.partOfSpeech, '名词');
  assert.match(dictionaryEntry(dictionary, 'We walk along the river.', 'bank').definition, /river/);
  assert.equal(dictionaryEntry([null, { meanings: {} }]), null);
});
test('Wiktionary fallback strips markup, skips empty senses and keeps license', () => {
  const parsed = dictionaryEntry(wiktionaryEntries(wiki, 'bank'), input().nearby, 'bank');
  assert.equal(parsed.definition, 'A financial institution & lender.');
  assert.equal(parsed.example, 'The bank approved a loan.');
  assert.equal(parsed.phonetic, '');
  assert.equal(parsed.license, 'CC BY-SA 4.0');
  assert.equal(dictionaryEntry(wiktionaryEntries(null, 'unknown')), null);
});
test('AI card validates structured output and drops unknown data', () => {
  const result = normalizeAiKnowledge(JSON.stringify({ meaning: '存钱和借钱的地方。', usage: 'x'.repeat(500), apiKey: 'not-a-card-field' }));
  assert.equal(result.provider, 'ai'); assert.equal(result.usage.length, 140); assert.equal(result.apiKey, undefined);
  assert.throws(() => normalizeAiKnowledge('{"meaning":""}'));
  assert.throws(() => normalizeAiKnowledge('not json'));
});
test('Anki export is UTF-8 two-field text with escaped provider HTML and source context', () => {
  const result = exportWordCards([card({ meaning: '<img src=x onerror=alert(1)>\nA\tB & C', phonetic: '/bæŋk/',
    sourceSentence: 'My bank.', pageUrl: 'https://example.com/a', provider: 'ai' }), card({ term: 'river' })]);
  assert.equal(result.filename, 'ez-reader-anki.txt');
  assert.match(result.text, /^#separator:Tab\n#html:true\n#columns:Front\tBack\n#tags:EZReader\n/);
  const rows = result.text.trim().split('\n').filter(line => !line.startsWith('#'));
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.split('\t').length === 2));
  assert.ok(!result.text.includes('<img')); assert.match(result.text, /&lt;img/);
  assert.match(result.text, /原句：My bank\./); assert.match(result.text, /DeepSeek AI/);
  assert.equal(normalizeWordCard(card({ pageUrl: 'javascript:alert(1)' })).pageUrl, '');
});
test('generic TSV uses exactly two plain-text fields and no spreadsheet formula prefix', () => {
  const result = exportWordCards([card({ translation: '=HYPERLINK("url")\tline\nbreak' })], 'tsv');
  assert.equal(result.text.trim().split('\n').length, 1);
  assert.equal(result.text.trim().split('\t').length, 2);
  assert.ok(result.text.startsWith('bank\t释义：='));
});
function storageFixture() {
  let bag = {};
  return { get: async () => structuredClone(bag), set: async patch => { bag = structuredClone({ ...bag, ...patch }); } };
}
test('simultaneous saves preserve both cards; re-saving a word updates it across providers', async () => {
  const book = createWordbook(storageFixture());
  const first = await book.save(card());
  await Promise.all([book.save(card({ term: 'river' })), book.save(card({ sourceLanguage: 'en-US', translation: '金融机构', provider: 'ai' }))]);
  const list = await book.list(); assert.equal(list.length, 2);
  assert.equal(list[0].id, first.id); assert.equal(list[0].translation, '金融机构');
  await book.remove(first.id); assert.equal((await book.list())[0].term, 'river');
});
test('wordbook cap is actionable, and failed writes do not break the queue', async () => {
  const storage = storageFixture();
  const entries = Array.from({ length: 500 }, (_, i) => card({ term: `word${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}`, id: String(i) }));
  await storage.set({ [WORDBOOK_KEY]: [...entries, { invalid: true }] });
  const book = createWordbook(storage);
  await assert.rejects(book.save(card()), /500/);
  await book.remove('0'); await book.save(card()); assert.equal((await book.list()).length, 500);
});
test('dictionary enrichment uses dictionary definitions, translates them, and caches completed cards', async () => {
  const calls = [];
  const service = createTranslationService({ fetchFn: async url => {
    calls.push(url);
    return response(url.includes('dictionaryapi') ? dictionary : { responseStatus: 200, responseData: { translatedText: '中文释义' } });
  } });
  const result = await service.learn(input(), config);
  assert.equal(result.knowledge.meaning, '中文释义'); assert.match(result.knowledge.example, /loan/);
  assert.equal(calls.length, 3); assert.ok(calls.every(url => !url.includes('deepseek')));
  assert.ok((await service.learn(input(), config)).cached); assert.equal(calls.length, 3);
});
test('dictionary outage falls back to Wiktionary, while absent words retain their basic card', async () => {
  const service = createTranslationService({ fetchFn: async url => url.includes('dictionaryapi')
    ? response({}, 522) : response(url.endsWith('/absent') ? null : wiki, url.endsWith('/absent') ? 404 : 200) });
  const found = await service.learn(input(), { ...config, target: 'en' });
  assert.equal(found.knowledge.meaning, 'A financial institution & lender.');
  assert.match(found.knowledge.dictionaryUrl, /wiktionary/);
  assert.equal((await service.learn(input({ text: 'absent' }), { ...config, target: 'en' })).available, false);
});
test('unavailable dictionary requests can be retried; unsupported languages do not make a request', async () => {
  let failing = true, count = 0;
  const service = createTranslationService({ fetchFn: async () => { count++; if (failing) throw new TypeError('offline'); return response(dictionary); } });
  await assert.rejects(service.learn(input(), { ...config, target: 'en' }), /无法连接/);
  failing = false;
  assert.ok((await service.learn(input(), { ...config, target: 'en' })).available);
  const before = count;
  assert.equal((await service.learn(input(), { source: 'ja' })).available, false); assert.equal(count, before);
});
test('AI card reuses analysis while translation stays translation-only, and page change gets new context', async () => {
  const bodies = [];
  const service = createTranslationService({ fetchFn: async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    const content = body.messages[0].content.includes('词语学习卡') ? JSON.stringify({ meaning: '存钱和借钱的地方。', example: 'I went to the bank.' })
      : body.response_format ? JSON.stringify({ topic: '银行金融', tone: '说明', terms: [] }) : '银行';
    return response({ choices: [{ finish_reason: 'stop', message: { content } }] });
  } });
  const ai = input({ provider: 'deepseek' });
  assert.equal((await service.translate(ai, config, 'test-key')).text, '银行');
  assert.equal((await service.learn(ai, config, 'test-key')).knowledge.provider, 'ai');
  assert.equal(bodies.length, 3); assert.equal(bodies[2].messages.length, 2);
  assert.ok(!bodies[2].messages.some(message => message.content.includes('"article":')));
  await service.learn({ ...ai, url: 'https://other.example/a' }, config, 'test-key');
  assert.equal(bodies.length, 5); assert.match(bodies[3].messages[0].content, /语境分析器/);
});
test('changing the page cancels dictionary enrichment without attempting fallback', async () => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const service = createTranslationService({ fetchFn: async (_url, options) => {
    calls++; started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const job = service.learn(input(), config);
  const rejected = assert.rejects(job, /页面或翻译设置/);
  await began; service.clear(); await rejected; assert.equal(calls, 1);
});
