import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelStore } from '../src/translation/models.js';
import { normalizeTranslation } from '../src/translation/config.js';

test('model discovery keeps API identifiers, deduplicates them and shares requests', async () => {
  const calls = [];
  const store = createModelStore({ fetchFn:async (url, options) => {
    calls.push({url,options});
    return {ok:true,json:async()=>({data:[{id:'new-chat-2027',name:'New Chat'}, {id:'new-chat-2027'}, {id:'<invalid>'}]})};
  } });
  const [a,b] = await Promise.all([store.load('test-key'),store.load('test-key')]);
  assert.deepEqual(a,[{id:'new-chat-2027',name:'New Chat'}]);
  assert.deepEqual(a,b); assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.deepseek.com/models');
  assert.equal(calls[0].options.headers.Authorization,'Bearer test-key');
  assert.equal(normalizeTranslation({model:a[0].id}).model,'new-chat-2027');
  await store.load('test-key',true); assert.equal(calls.length,2);
  await store.load('another-key'); assert.equal(calls.length,3);
});

test('model discovery failures never supply a static fallback and can be retried', async () => {
  let calls=0;
  const store=createModelStore({fetchFn:async()=>{calls++;return calls===1?{ok:false,status:401}:{ok:true,json:async()=>({data:[{id:'available'}]})};}});
  await assert.rejects(store.load(''),/保存.*API Key/); assert.equal(calls,0);
  await assert.rejects(store.load('key'),/Key 无效/);
  assert.deepEqual(await store.load('key'),[{id:'available',name:'available'}]);
  store.clear(); await store.load('key'); assert.equal(calls,3);
});
