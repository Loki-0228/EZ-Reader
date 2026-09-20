import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerWindowToolbar } from '../src/background/window-toolbar.js';

function fixture() {
  const bag = {}, deliveries = [], injections = [], listeners = {};
  const event = name => ({ addListener: callback => { listeners[name] = callback; } });
  const tabs = [{id:1,windowId:10,url:'https://example.com/a'},{id:2,windowId:10,url:'https://example.com/b'},
    {id:3,windowId:20,url:'https://example.com/c'},{id:4,windowId:10,url:'edge://settings'}];
  const api = { runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onMessage:event('message')},
    storage:{session:{get:async key=>({[key]:bag[key]}),set:async values=>Object.assign(bag,values),remove:async key=>{delete bag[key];}}},
    tabs:{get:async id=>({...tabs.find(tab=>tab.id===id)}),query:async query=>tabs.filter(tab=>tab.windowId===query.windowId),
      onActivated:event('activate'),onUpdated:event('update'),onAttached:event('attach')},windows:{onRemoved:event('remove')} };
  const transport = {send:async (id,message)=>{deliveries.push({id,...message});return {ok:true};},inject:async id=>{injections.push(id);return {ok:true};}};
  const sender = {id:'test',tab:tabs[0],frameId:0};
  return {bag,deliveries,injections,tabs,api,listeners,sender,transport,controller:registerWindowToolbar(api,transport)};
}
const set = (f, enabled, sender=f.sender) => f.controller.handle({type:'ezr:window-toolbar:set',enabled},sender);

test('toolbar state and broadcasts are scoped to the trusted sender window',async()=>{
  const f=fixture(); await set(f,true);
  assert.deepEqual(f.deliveries.map(item=>item.id),[1,2]);
  assert.equal(f.bag['ezr:toolbar:window:10'].enabled,true);
  assert.equal(f.bag['ezr:toolbar:window:20'],undefined);
  const reloaded=registerWindowToolbar(f.api,f.transport);
  assert.equal((await reloaded.handle({type:'ezr:window-toolbar:get'},f.sender)).enabled,true);
});
test('rapid open then close cannot resurrect a toolbar',async()=>{
  const f=fixture(); await Promise.all([set(f,true),set(f,false)]);
  assert.equal(f.bag['ezr:toolbar:window:10'].enabled,false);
  assert.deepEqual(f.deliveries.filter(item=>item.id===1).map(item=>[item.enabled,item.revision]),[[true,1],[false,2]]);
});
test('navigation reuses window state and a moved tab adopts its destination window',async()=>{
  const f=fixture(); await set(f,true);f.deliveries.length=0;
  await f.controller.sync(2);assert.equal(f.deliveries[0].enabled,true);
  f.tabs[1].windowId=20;await f.controller.sync(2,true);
  assert.equal(f.deliveries.at(-1).enabled,false);assert.equal(f.deliveries.at(-1).windowId,20);
  await set(f,true,{id:'test',tab:f.tabs[2],frameId:0});
  await f.controller.sync(2,true);assert.equal(f.deliveries.at(-1).enabled,true);
});
test('window closure removes its state without changing other windows',async()=>{
  const f=fixture();await set(f,true);await set(f,true,{id:'test',tab:f.tabs[2],frameId:0});
  f.listeners.remove(10);await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.bag['ezr:toolbar:window:10'],undefined);assert.equal(f.bag['ezr:toolbar:window:20'].enabled,true);
});
test('foreign senders and subframes cannot set window state or spoof another tab',async()=>{
  const f=fixture();await assert.rejects(()=>set(f,true,{...f.sender,id:'foreign'}));
  await assert.rejects(()=>set(f,true,{...f.sender,frameId:4}));
  await f.controller.handle({type:'ezr:window-toolbar:set',enabled:true,tabId:3},f.sender);
  assert.equal(f.bag['ezr:toolbar:window:20'],undefined);
  await f.controller.handle({type:'ezr:window-toolbar:set',enabled:true,tabId:3},{id:'test',url:'chrome-extension://test/pages/popup.html'});
  assert.equal(f.bag['ezr:toolbar:window:20'].enabled,true);
});
