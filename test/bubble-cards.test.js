import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslationService } from '../src/translation/service.js';
import { bubbleKey, termMatch } from '../src/ui/bubble-cards.js';
import { normalizeTranslation, patchTranslation, translationMode, translationModePatch } from '../src/translation/config.js';

const config = { enabled:false, bubbleCards:true, source:'en', target:'zh-CN', level:'B1', provider:'deepseek' };
const input = texts => ({ slot:'5:0', documentId:'a', url:'https://example.com/', provider:'deepseek', texts,
  view:{ id:'page', context:'The bank manages financial deposits.', title:'Banking', language:'en', fullDocument:true } });
function setup(transform = data => data) {
  const calls = [];
  const service = createTranslationService({ fetchFn:async (url, options) => {
    const body = JSON.parse(options.body), payload = JSON.parse(body.messages.at(-1).content); calls.push({ body, payload });
    const data = { segments:payload.segments.map(segment => ({ id:segment.id, text:`银行金融：${segment.text}`,
      words:[{ term:'bank', translation:'银行', translatedTerm:'银行', meaning:'管理资金的机构。' },
        { term:'financial', translation:'金融的', translatedTerm:'幻觉词语' }, { term:'invented', translation:'虚构' }] })) };
    return { ok:true, json:async () => ({ choices:[{ message:{ content:JSON.stringify(transform(data)) } }] }) };
  } });
  return { service, calls };
}
test('bubble mode disables selection translation and uses one combined request', async () => {
  const { service, calls } = setup();
  const result = await service.full(input(['The bank.', 'financial deposits']), config, 'test-key');
  assert.equal(calls.length, 1); assert.equal(result.results.length, 2);
  assert.equal(result.results[0].words[0].term, 'bank');
  assert.equal(result.results[1].words[0].term, 'financial');
  assert.equal(result.results[1].words[0].translatedTerm, '');
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.equal(calls[0].payload.learnerLevel, 'B1');
  assert.equal(normalizeTranslation({ enabled:false, bubbleCards:true }).bubbleCards, true);
});

test('standalone bubbles use a distinct prompt, never fill translation cache, and feed later combined requests', async () => {
  const { service, calls } = setup();
  const page = input(['The bank.']);
  const [first, concurrent] = await Promise.all([service.full({ ...page, cardsOnly:true }, config, 'key'), service.full({ ...page, cardsOnly:true }, config, 'key')]);
  assert.equal(calls.length, 1);
  assert.equal(first.results[0].text, undefined);
  assert.equal(concurrent.results[0].words[0].term, 'bank');
  assert.equal(calls[0].payload.segments[0].existingTranslation, undefined);
  assert.match(calls[0].body.messages[0].content, /不翻译全文或整段/);
  const translated = await service.full(page, config, 'key');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body.messages[0].content, calls[1].body.messages[0].content);
  assert.equal(calls[1].payload.segments[0].existingTranslation, '');
  assert.equal(calls[1].payload.segments[0].existingWords[0].term, 'bank');
  assert.ok(translated.results[0].text);
  const original = await service.full({ ...page, cardsOnly:true }, config, 'key');
  assert.equal(calls.length, 2); assert.equal(original.results[0].text, undefined);
});

test('standalone malformed segments retry without discarding successful cards or blocking combined translation', async () => {
  let broken = true;
  const { service, calls } = setup(data => ({ segments:data.segments.map((item, index) => broken && index === 1 ? { ...item, words:null } : item) }));
  const page = { ...input(['The bank.', 'financial deposits']), cardsOnly:true };
  const first = await service.full(page, config, 'key');
  assert.ok(first.error); assert.equal(first.results.length, 1);
  broken = false;
  assert.equal((await service.full(page, config, 'key')).results.length, 2);
  assert.deepEqual(calls[1].payload.segments.map(item => item.text), ['financial deposits']);
  assert.equal((await service.full({ ...page, cardsOnly:false }, config, 'key')).results.length, 2);
});

test('standalone bubbles never call a paid or free provider outside DeepSeek bubble mode', async () => {
  const { service, calls } = setup();
  await service.full({ ...input(['bank']), cardsOnly:true, provider:'free' }, config);
  await service.full({ ...input(['bank']), cardsOnly:true }, { ...config, bubbleCards:false }, 'key');
  assert.equal(calls.length, 0);
});

test('switching to original text during a combined request shares the in-flight glossary', async () => {
  const { service, calls } = setup();
  const page = input(['The bank.']);
  const [translated, original] = await Promise.all([service.full(page, config, 'key'), service.full({ ...page, cardsOnly:true }, config, 'key')]);
  assert.equal(calls.length, 1);
  assert.ok(translated.results[0].text);
  assert.equal(original.results[0].text, undefined);
  assert.equal(original.results[0].words[0].term, 'bank');
});

test('legacy conflicting flags migrate to usable bubbles; partial writes switch modes both ways', () => {
  const legacy = normalizeTranslation({ enabled:true, bubbleCards:true });
  assert.equal(legacy.enabled, false);
  assert.equal(translationMode(legacy), 'bubbles');
  const selection = patchTranslation(legacy, { enabled:true });
  assert.equal(selection.bubbleCards, false);
  assert.equal(translationMode(selection), 'selection');
  const bubbles = patchTranslation(selection, { bubbleCards:true });
  assert.equal(bubbles.enabled, false);
  assert.equal(translationMode(bubbles), 'bubbles');
  const off = patchTranslation(bubbles, translationModePatch('off'));
  assert.equal(off.enabled, false); assert.equal(off.bubbleCards, false);
  assert.equal(translationMode(off), 'off');
  assert.equal(translationMode(patchTranslation(off, { target:'ja' })), 'off');
  assert.equal(translationMode(normalizeTranslation()), 'selection');
});

test('bubble mode blocks selection requests but keeps manual input and free full translation available', async () => {
  let calls = 0;
  const service = createTranslationService({ fetchFn:async url => {
    assert.ok(String(url).startsWith('https://api.mymemory.translated.net/'));
    calls++;
    return { ok:true, json:async () => ({ responseStatus:200, responseData:{ translatedText:'银行' } }) };
  } });
  const request = { ...input(['bank']), text:'bank', provider:'free' };
  await assert.rejects(service.translate(request, config), /划词翻译已关闭/);
  assert.equal(calls, 0);
  assert.equal((await service.translate({ ...request, freeform:true }, config)).text, '银行');
  assert.equal((await service.full(request, config)).results[0].text, '银行');
  assert.equal(calls, 2);
});
test('combined results deduplicate concurrent requests and reuse text across level changes', async () => {
  const { service, calls } = setup();
  const page = input(['The bank.']);
  await Promise.all([service.full(page, config, 'key'), service.full(page, config, 'key')]);
  assert.equal(calls.length, 1);
  await service.full(page, { ...config, bubbleCards:false }, 'key'); assert.equal(calls.length, 1);
  await service.full(page, { ...config, level:'C1' }, 'key');
  assert.equal(calls.length, 2); assert.equal(calls[1].payload.segments[0].existingTranslation, '银行金融：The bank.');
});
test('missing segment IDs preserve successful segments and retry only missing ones', async () => {
  let fail = true;
  const { service, calls } = setup(data => fail ? { segments:data.segments.slice(0, 1) } : data);
  const page = input(['The bank.', 'financial deposits']);
  const first = await service.full(page, config, 'key'); assert.ok(first.error); assert.equal(first.results.length, 1);
  fail = false;
  const next = await service.full(page, config, 'key'); assert.equal(next.error, undefined); assert.equal(next.results.length, 2);
  assert.deepEqual(calls[1].payload.segments.map(item => item.text), ['financial deposits']);
});
test('bad card payload keeps translation and excludes closed or absent vocabulary', async () => {
  const { service } = setup();
  const result = await service.full({ ...input(['The bank.']), excludeTerms:['bank'] }, config, 'key');
  assert.equal(result.results[0].words.length, 0); assert.ok(result.results[0].text);
  const invalid = setup(data => ({ segments:data.segments.map(item => ({ ...item, words:'invalid' })) }));
  assert.equal((await invalid.service.full(input(['The bank.']), config, 'key')).results[0].words.length, 0);
});
test('duplicate IDs and malformed responses fail without poisoning retry cache', async () => {
  let fail = true;
  const { service } = setup(data => fail ? { segments:[...data.segments, ...data.segments] } : data);
  assert.ok((await service.full(input(['bank']), config, 'key')).error);
  fail = false;
  assert.equal((await service.full(input(['bank']), config, 'key')).results.length, 1);
});

test('queued card and plain requests for the same text cannot wait on each other', async () => {
  let release, requestStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requestStarted = resolve; });
  const calls = [];
  const service = createTranslationService({ fetchFn:async (url, options) => {
    const body = JSON.parse(options.body), payload = JSON.parse(body.messages.at(-1).content);
    calls.push(payload);
    requestStarted();
    if (calls.length === 1) await gate;
    const content = payload.segments ? JSON.stringify({segments:payload.segments.map(segment=>({id:segment.id,text:'译文：'+segment.text,words:[]}))})
      : body.response_format ? JSON.stringify({topic:'Banking',tone:'Clear',terms:[]}) : '译文：'+payload.text;
    return {ok:true,json:async()=>({choices:[{message:{content}}]})};
  }});
  const first = service.full(input(['bank']),config,'key');
  await Promise.race([started, first]);
  assert.equal(calls.length, 1);
  const cards = service.full(input(['financial']),config,'key');
  await new Promise(resolve=>setTimeout(resolve,20));
  const plain = service.full(input(['financial']),{...config,bubbleCards:false},'key');
  await new Promise(resolve=>setTimeout(resolve,20));
  release();
  let timer;
  try {
    const results = await Promise.race([Promise.all([first,cards,plain]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('全文请求队列互相等待')),1000);})]);
    assert.ok(results.every(result=>result.results.length===1));
    assert.equal(calls.length,2);
  } finally { clearTimeout(timer); service.clear(); }
});

test('malformed individual word cards cannot discard complete translated segments', async () => {
  const {service}=setup(data=>({segments:data.segments.map(segment=>({...segment,words:[{term:'bank',translation:'\u0000'},{term:'financial',translation:'金融的'}]}))}));
  const result=await service.full(input(['The bank provides financial services.']),config,'key');
  assert.equal(result.error,undefined);
  assert.equal(result.results.length,1);
  assert.deepEqual(result.results[0].words.map(word=>word.term),['financial']);
});
test('matching respects word boundaries, case, regex characters and target language identity', () => {
  assert.equal(termMatch('banking', 'bank'), null);
  assert.equal(termMatch('The BANK account', 'bank')[0], 'BANK');
  assert.equal(termMatch('open a bank   account', 'bank account')[0], 'bank   account');
  assert.equal(termMatch('text', '(text)'), null);
  assert.equal(bubbleKey({ term:'BANK', targetLanguage:'zh-CN' }), bubbleKey({ term:'bank', targetLanguage:'zh-cn' }));
});
