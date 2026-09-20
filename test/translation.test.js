import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationService, splitUtf8 } from '../src/translation/service.js';
import { sampleContext, MAX_CONTEXT } from '../src/translation/config.js';

const input = (patch = {}) => ({ slot: '1:0', documentId: 'document-a', url: 'https://example.com/a',
  view: { id: 'view-a', title: 'Banking', context: 'A bank manages financial deposits.', language: 'en' },
  text: 'bank', nearby: 'A bank manages financial deposits.', provider: 'deepseek', ...patch });
const config = { source: 'en', target: 'zh-CN', model: 'deepseek-flash' };
const key = 'sk-unit-test-not-a-real-key';
const response = data => ({ ok: true, status: 200, json: async () => data });
function fixture(extra = {}) {
  const calls = [], summaries = new Map();
  const service = createTranslationService({ saved: {
    get: async slot => summaries.get(slot), set: async (slot, data) => summaries.set(slot, data),
    remove: async slot => summaries.delete(slot), clear: async () => summaries.clear(),
  }, fetchFn: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    if (!body) return response({ responseStatus: 200, responseData: { translatedText: '免费译文' } });
    return response({ choices: [{ finish_reason: 'stop', message: { content: body.response_format
      ? JSON.stringify({ topic: '银行金融', tone: '专业', terms: [{ source: 'bank', target: '银行' }] }) : '银行' } }] });
  }, ...extra });
  return { service, calls, summaries };
}
test('DeepSeek analyzes once and later sends only bounded summary and current selection, never chat history', async () => {
  const { service, calls, summaries } = fixture();
  await service.translate(input(), config, key);
  await service.translate(input({ text: 'deposit' }), config, key);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(call => call.body.response_format).length, 1);
  assert.equal(calls[2].body.messages.length, 4);
  assert.ok(!JSON.stringify(calls[2].body).includes('"article":'));
  assert.ok(!calls[2].body.messages.some(message => message.role === 'assistant' && message.content === '银行'));
  assert.equal(calls[0].body.thinking.type, 'disabled');
  assert.ok(!JSON.stringify([...summaries.values()]).includes('financial deposits'));
  assert.ok(!JSON.stringify([...summaries.values()]).includes(key));
});
test('page, site, document and reader-region changes each rebuild DeepSeek context', async () => {
  const { service, calls } = fixture();
  await service.translate(input(), config, key);
  for (const change of [{ url: 'https://example.com/b' }, { url: 'https://other.com/' },
    { documentId: 'document-b' }, { view: { ...input().view, id: 'view-b' } }]) {
    await service.translate(input(change), config, key);
  }
  assert.equal(calls.filter(call => call.body.response_format).length, 5);
});
test('parallel selections share one analysis; exact repeats are cached', async () => {
  const { service, calls } = fixture();
  await Promise.all([service.translate(input(), config, key), service.translate(input({ text: 'deposit' }), config, key)]);
  assert.equal(calls.filter(call => call.body.response_format).length, 1);
  const result = await service.translate(input(), config, key);
  assert.equal(result.cached, true);
  assert.equal(calls.length, 3);
});
test('tabs are isolated and target-language changes invalidate context', async () => {
  const { service, calls } = fixture();
  await service.translate(input(), config, key);
  await service.translate(input({ slot: '2:0' }), config, key);
  await service.translate(input(), { ...config, target: 'ja' }, key);
  assert.equal(calls.filter(call => call.body.response_format).length, 3);
});
test('summary persists across worker recreation without storing original article or key', async () => {
  const stored = new Map();
  const saved = { get: async s => stored.get(s), set: async (s, d) => stored.set(s, d) };
  await fixture({ saved }).service.translate(input(), config, key);
  const next = fixture({ saved });
  await next.service.translate(input({ text: 'new selection' }), config, key);
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].body.response_format, undefined);
});
test('free provider sends selected text only and never authorization or article context', async () => {
  const { service, calls } = fixture();
  await service.translate(input({ provider: 'free', text: 'Hello world' }), config, key);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'Hello world');
  assert.equal(calls[0].options.headers, undefined);
  assert.ok(!calls[0].url.includes('financial'));
});
test('UTF-8 chunks preserve all Chinese and emoji text under 500 bytes', () => {
  const text = '中文文字🙂 mixed words.\n'.repeat(120);
  const chunks = splitUtf8(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => new TextEncoder().encode(chunk).length <= 480));
});
test('empty selection, missing key, disabled feature and oversized selection never fetch', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.translate(input(), config), /API Key/);
  await assert.rejects(service.translate(input({ text: '' }), config, key), /字符/);
  await assert.rejects(service.translate(input({ text: 'a'.repeat(2001) }), config, key), /字符/);
  await assert.rejects(service.translate(input(), { ...config, enabled: false }, key), /关闭/);
  assert.equal(calls.length, 0);
});
test('provider auth and quota errors are actionable and do not echo response bodies', async () => {
  const service = createTranslationService({ fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ secret: key }) }) });
  await assert.rejects(service.translate(input(), config, key), error => /API Key 无效/.test(error.message) && !error.message.includes(key));
  const free = createTranslationService({ fetchFn: async () => response({ quotaFinished: true, responseStatus: 200 }) });
  await assert.rejects(free.translate(input({ provider: 'free' }), config), /额度已用完/);
});
test('failed context analysis is retried, never cached as successful', async () => {
  let count = 0;
  const { service } = fixture({ fetchFn: async () => { count++; return response({ choices: [{ message: { content: 'bad json' } }] }); } });
  await assert.rejects(service.translate(input(), config, key), /格式无效/);
  await assert.rejects(service.translate(input(), config, key), /格式无效/);
  assert.equal(count, 2);
});
test('changing view aborts an in-flight translation and prevents stale cache writes', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { service } = fixture({ fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) });
  const pending = service.translate(input(), config, key);
  await ready;
  service.clearFrame('1:0');
  await assert.rejects(pending, /页面或翻译设置已改变/);
});
test('long article sampling is bounded and includes the beginning and end', () => {
  const sampled = sampleContext(`BEGIN ${'body '.repeat(10000)} END`);
  assert.ok(sampled.length <= MAX_CONTEXT);
  assert.ok(sampled.startsWith('BEGIN') && sampled.endsWith('END'));
});
