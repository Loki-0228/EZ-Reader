import { test } from 'node:test';
import assert from 'node:assert/strict';

let serial=0;
async function fixture({url='https://example.com/',enabled=false,active=true,visible=false,failRead=false}={}) {
  const previous={document:globalThis.document,window:globalThis.window,chrome:globalThis.chrome};
  const nodes=new Map(['primary','primary-label','notice','documents'].map(id=>[id,{disabled:id==='primary',textContent:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}}]));
  const calls=[];
  globalThis.document={getElementById:id=>nodes.get(id)};
  globalThis.window={close(){}};
  globalThis.chrome={runtime:{getURL:path=>'chrome-extension://test/'+path,sendMessage:async message=>{
    calls.push(message);
    if(message.type==='ezr:document-toolbar') return {ok:true,topFrame:true,active,toolbarsVisible:visible};
    if(message.type==='ezr:window-toolbar:get'&&failRead) throw Error('worker unavailable');
    return {ok:true,enabled:message.type.endsWith(':set')?message.enabled:enabled,available:true};
  }},tabs:{query:async()=>[{id:1,url}],sendMessage:async()=>({ok:true,topFrame:true,active,toolbarsVisible:visible})}};
  await import('../src/pages/popup.js?case='+serial++);
  await new Promise(resolve=>setTimeout(resolve,0));
  return {nodes,calls,restore(){for(const [name,value] of Object.entries(previous)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}}};
}

test('webpage reopen stays actionable when worker state loading fails',async()=>{
  const f=await fixture({failRead:true});
  try {assert.equal(f.nodes.get('primary').disabled,false);await f.nodes.get('primary').listeners.click();assert.ok(f.calls.some(call=>call.type.endsWith(':set')&&call.enabled===true));}
  finally{f.restore();}
});
test('inactive webpage session can reopen instead of offering a stale close action',async()=>{
  const f=await fixture({enabled:true,active:false});
  try{assert.equal(f.nodes.get('primary').disabled,false);assert.equal(f.nodes.get('primary-label').textContent,'网页工具栏');await f.nodes.get('primary').listeners.click();assert.equal(f.calls.at(-1).enabled,true);}
  finally{f.restore();}
});
test('closed PDF reader toolbars can reopen while the window switch is disabled',async()=>{
  const f=await fixture({url:'chrome-extension://test/pages/document-reader.html#document'});
  try{assert.equal(f.nodes.get('primary').disabled,false);assert.equal(f.nodes.get('primary-label').textContent,'打开 PDF 工具栏');await f.nodes.get('primary').listeners.click();assert.equal(f.calls.at(-1).enabled,true);}
  finally{f.restore();}
});
test('browser restricted pages stay disabled when the window switch is off',async()=>{
  const f=await fixture({url:'edge://settings'});
  try{assert.equal(f.nodes.get('primary').disabled,true);}finally{f.restore();}
});
