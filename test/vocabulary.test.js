import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranslation, translationContextKey } from '../src/translation/config.js';
import { normalizeVocabulary } from '../src/translation/vocabulary.js';
import { createTranslationService } from '../src/translation/service.js';
import { createWordbook } from '../src/translation/wordbook.js';
import { WORDBOOK_KEY } from '../src/translation/word-card.js';

const text = 'The bank manages financial deposits. Vegetation prevents erosion near the river.';
const input = patch => ({ slot: '1:0', documentId: 'doc', url: 'https://example.com/a', provider: 'deepseek', text,
  view: { id: 'v', context: text, title: 'Finance and ecology', language: 'en' }, ...patch });
const words = [{ term: 'financial', translation: '金融的', meaning: '和资金管理有关。', usage: 'financial services：金融服务' },
  { term: 'erosion', translation: '侵蚀', meaning: '水或风使土壤逐渐流失。' }];
function fixture() {
  const calls = [];
  const service = createTranslationService({ fetchFn: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    const system = body.messages[0].content;
    const content = system.includes('挑选值得学习的英文生词') ? JSON.stringify({ words })
      : system.includes('词语学习卡') ? JSON.stringify({ meaning: '和资金管理有关。' })
      : body.response_format ? JSON.stringify({ topic: '金融与生态', tone: '说明', terms: [] }) : '译文';
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
  } });
  return { calls, service };
}
test('preload, explanations, generated cards and saving are independent opt-ins', () => {
  const defaults = normalizeTranslation();
  assert.equal(defaults.preload, false); assert.equal(defaults.autoSave, false);
  const plain = normalizeTranslation({ explanations: false, wordCards: true });
  assert.equal(plain.explanations, false); assert.equal(plain.wordCards, true);
  assert.equal(normalizeTranslation({ level: 'invalid' }).level, 'B1');
  assert.equal(translationContextKey(defaults), translationContextKey({ ...defaults, provider: 'deepseek', preload: true, level: 'C2', wordCards: false }));
});
test('generated words are grounded, deduplicated and cannot invent original sentences', () => {
  const result = normalizeVocabulary(JSON.stringify({ words: [...words, { term: 'inancial', translation: '无效子串' },
    { ...words[0], term: 'FINANCIAL' }, { term: 'imaginary', translation: '文章外词语' }, { term: '<script>', translation: 'unsafe' }] }), text, { target: 'zh-CN', level: 'B2' });
  assert.deepEqual(result.map(word => word.term), ['financial', 'erosion']);
  assert.equal(result[0].sourceSentence, 'The bank manages financial deposits.');
  assert.equal(result[1].sourceSentence, 'Vegetation prevents erosion near the river.');
  assert.equal(result[0].level, 'B2');
});
test('card-only generation strips explanations even if a model incorrectly supplies them', () => {
  const result = normalizeVocabulary(JSON.stringify({ words }), text, { target: 'zh-CN', level: 'B1', explanations: false });
  assert.equal(result[0].translation, '金融的'); assert.equal(result[0].meaning, ''); assert.equal(result[0].usage, '');
});
test('vocabulary output is capped at six and supports genuinely empty results', () => {
  const terms = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const result = normalizeVocabulary(JSON.stringify({ words: terms.map(term => ({ term, translation: term })) }), terms.join(' '), { target: 'en', level: 'A1' });
  assert.equal(result.length, 6);
  assert.deepEqual(normalizeVocabulary('{"words":[]}', text, { target: 'en', level: 'C2' }), []);
  assert.throws(() => normalizeVocabulary('{"words":{}}', text, {}));
});
test('disabling explanations suppresses dictionary and AI enrichment, independently of cards', async () => {
  const { service, calls } = fixture();
  for (const provider of ['free', 'deepseek']) assert.equal((await service.learn(input({ provider, text: 'financial' }), { explanations: false, wordCards: true }, 'test-key')).available, false);
  assert.equal(calls.length, 0);
  assert.ok((await service.learn(input({ text: 'financial' }), { explanations: true, wordCards: false }, 'test-key')).available);
  assert.equal(calls.length, 2);
});
test('AI difficulty changes vocabulary requests while reusing context and pure translation cache', async () => {
  const { service, calls } = fixture();
  await service.translate(input(), { level: 'B1' }, 'test-key');
  await service.vocabulary(input(), { level: 'B1' }, 'test-key');
  await service.vocabulary(input(), { level: 'C1' }, 'test-key');
  assert.equal(calls.filter(call => call.body.messages[0].content.includes('语境分析器')).length, 1);
  const payloads = calls.filter(call => call.body.messages[0].content.includes('挑选值得学习')).map(call => JSON.parse(call.body.messages[1].content));
  assert.deepEqual(payloads.map(item => item.learnerLevel), ['B1', 'C1']);
  assert.ok(payloads.every(item => item.text === text && item.includeExplanation));
  const before = calls.length;
  assert.ok((await service.vocabulary(input(), { level: 'C1' }, 'test-key')).cached);
  assert.ok((await service.translate(input(), { level: 'C1', preload: true }, 'test-key')).cached);
  assert.equal(calls.length, before);
});
test('card-only passage request asks only for terms and translations; free mode never silently uses AI', async () => {
  const { service, calls } = fixture();
  const result = await service.vocabulary(input(), { explanations: false, wordCards: true }, 'test-key');
  assert.equal(JSON.parse(calls.at(-1).body.messages[1].content).includeExplanation, false);
  assert.ok(result.words.every(word => !word.meaning));
  await assert.rejects(service.vocabulary(input({ provider: 'free' }), {}, 'test-key'), /DeepSeek/);
  const before = calls.length;
  assert.equal((await service.vocabulary(input(), { explanations: false, wordCards: false }, 'test-key')).available, false);
  assert.equal(calls.length, before);
});
test('whole article vocabulary stays bounded and changes context when page changes', async () => {
  const { service, calls } = fixture();
  await service.vocabulary(input({ text: text.repeat(30) }), {}, 'test-key');
  await service.vocabulary(input({ url: 'https://other.example/b' }), {}, 'test-key');
  assert.equal(calls.filter(call => call.body.messages[0].content.includes('语境分析器')).length, 2);
  await assert.rejects(service.vocabulary(input({ text: 'x'.repeat(12001) }), {}, 'test-key'), /12000/);
});
test('batch saves are atomic at capacity, do not implicitly save generated data', async () => {
  let stored = { [WORDBOOK_KEY]: [] };
  const book = createWordbook({ get: async () => structuredClone(stored), set: async bag => { stored = structuredClone(bag); } });
  const generated = normalizeVocabulary(JSON.stringify({ words }), text, { target: 'zh-CN', level: 'B2' });
  assert.equal((await book.list()).length, 0);
  await book.saveMany(generated); assert.equal((await book.list()).length, 2);
  stored[WORDBOOK_KEY] = Array.from({ length: 499 }, (_, i) => ({ term: `word${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}`, translation: '词', id: String(i) }));
  await assert.rejects(book.saveMany(generated), /500/);
  assert.equal((await book.list()).length, 499);
});
