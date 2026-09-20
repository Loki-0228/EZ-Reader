import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTranslationText, joinTranslations } from '../src/dom/translation-text.js';
import { createTranslationService, splitUtf8 } from '../src/translation/service.js';

const input = texts => ({ slot: '1:0', documentId: 'doc', url: 'https://example.com/article',
  view: { id: 'page', title: 'Bank', context: 'The bank manages deposits.', language: 'en', fullDocument: true }, texts, provider: 'deepseek' });
const config = { source: 'en', target: 'zh-CN', model: 'deepseek-flash' }, key = 'sk-test-only-key';
function fixture(extra = {}) {
  const calls = [];
  const service = createTranslationService({ detectLanguage: async () => ({ languages: [] }), fetchFn: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const q = body ? null : new URL(url).searchParams.get('q');
    calls.push({ url, body, options, q });
    const failure = extra.fail?.({ body, q, count: calls.length });
    if (failure) return { ok: false, status: failure };
    if (!body) return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: '免费译文：' + q } }) };
    const system = body.messages[0].content;
    const content = system.includes('语境分析器') ? JSON.stringify({ topic: 'Banking', tone: 'Clear', terms: [] })
      : system.includes('词语学习卡') ? JSON.stringify({ meaning: '银行', usage: 'bank account' })
      : '银行译文';
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
  } });
  return { calls, service };
}

test('DeepSeek full translation accepts plain text with no word alignment or JSON translation requirement', async () => {
  const { service, calls } = fixture();
  const result = await service.full(input(['bank', 'loans']), config, key);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].text, '银行译文');
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 3);
  for (const call of calls.slice(1)) {
    assert.equal(call.body.response_format, undefined);
    assert.equal(Object.hasOwn(JSON.parse(call.body.messages.at(-1).content), 'tokens'), false);
    assert.ok(!JSON.stringify(call.body).includes('词语对应'));
  }
});

test('free full translation needs no key, makes no DeepSeek call and falls back to document language', async () => {
  const { service, calls } = fixture();
  const result = await service.full({ ...input(['bank']), provider: 'free' }, { ...config, source: 'auto', enabled: false });
  assert.equal(result.results[0].text, '免费译文：bank');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, null);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(new URL(calls[0].url).searchParams.get('langpair'), 'en|zh-CN');
});

test('free long Unicode runs fit the API byte limit without dropping source text', async () => {
  const { service, calls } = fixture();
  const text = '日本語😀中文 '.repeat(120);
  await service.full({ ...input([text]), provider: 'free' }, { ...config, source: 'ja', target: 'en' });
  assert.ok(calls.every(call => new TextEncoder().encode(call.q).length <= 480));
  // Repeated chunks intentionally share a request; compare the result to unique API-sized pieces.
  assert.deepEqual(calls.map(call => call.q), [...new Set(splitUtf8(text))]);
});

test('full translation caches duplicates and simultaneous requests, and keeps provider results separate', async () => {
  const { service, calls } = fixture();
  const page = input(['bank', 'bank']);
  await Promise.all([service.full(page, config, key), service.full(page, config, key)]);
  assert.equal(calls.length, 2);
  service.clearFrame('1:0');
  assert.equal((await service.full(page, config, key)).cached, true);
  await service.full({ ...page, provider: 'free' }, config);
  assert.equal(calls.length, 3);
  await service.full(page, config, key);
  assert.equal(calls.length, 3);
  const result = await service.translate({ ...page, text: 'bank', nearby: 'bank context' }, config, key);
  assert.equal(result.cached, true);
  assert.equal(calls.length, 3);
});

test('quota failure preserves completed runs, stops the rest of a batch and retries only unfinished runs', async () => {
  let fail = true;
  const { service, calls } = fixture({ fail: ({ q }) => q === 'two' && fail ? 429 : 0 });
  const page = { ...input(['one', 'two', 'three']), provider: 'free' };
  const first = await service.full(page, config);
  assert.match(first.error, /额度|请求过多/);
  assert.deepEqual(first.results.map(result => result.source), ['one']);
  assert.deepEqual(calls.map(call => call.q), ['one', 'two']);
  fail = false;
  const second = await service.full(page, config);
  assert.equal(second.error, undefined);
  assert.equal(second.results.length, 3);
  assert.deepEqual(calls.map(call => call.q), ['one', 'two', 'two', 'three']);
});

test('failed free paragraph retries reuse successful UTF-8 chunks', async () => {
  let fail = true;
  const { service, calls } = fixture({ fail: ({ count }) => count === 2 && fail ? 429 : 0 });
  const page = { ...input(['word '.repeat(180)]), provider: 'free' };
  assert.ok((await service.full(page, config)).error);
  fail = false;
  assert.equal((await service.full(page, config)).error, undefined);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].q, calls[2].q);
  assert.notEqual(calls[0].q, calls[2].q);
});

test('full text and level-specific learning share context and survive selection UI closure', async () => {
  const { service, calls } = fixture();
  const page = input(['bank']);
  await service.full(page, config, key);
  const selected = { ...page, text: 'bank', translation: '银行' };
  await service.learn(selected, { ...config, level: 'A2' }, key);
  service.clearFrame('1:0');
  await service.learn(selected, { ...config, level: 'A2' }, key);
  assert.equal(calls.length, 3);
  await service.learn(selected, { ...config, level: 'C1' }, key);
  assert.equal(calls.length, 4);
  assert.equal(JSON.parse(calls.at(-1).body.messages[1].content).learnerLevel, 'C1');
  await service.full({ ...page, url: 'https://other.example/' }, config, key);
  assert.equal(calls.length, 6);
});

test('only DeepSeek needs credentials, malformed batches still fail and language changes invalidate results', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.full(input(['bank']), config), /API Key/);
  assert.equal(calls.length, 0);
  await service.full(input(['bank']), { ...config, enabled: false }, key);
  await assert.rejects(service.full(input(['a'.repeat(1201)]), config, key), /过大/);
  await service.full(input(['bank']), { ...config, target: 'ja' }, key);
  assert.equal(calls.length, 4);
});

test('plain splitting preserves Unicode and joins non-CJK text without losing word boundaries', () => {
  const text = 'Bank deposits 😀. 中文句子。'.repeat(200);
  const chunks = splitTranslationText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 1000 && !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.equal(joinTranslations([{ source: 'one ', text: 'First', target: 'en' }, { source: 'two', text: 'second', target: 'en' }]), 'First second');
  assert.equal(joinTranslations([{ source: 'one ', text: '甲', target: 'zh-CN' }, { source: 'two', text: '乙', target: 'zh-CN' }]), '甲乙');
});
