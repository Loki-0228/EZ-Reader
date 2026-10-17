import { CdpPage } from './cdp.js';

/** Exercise actual PDF selections with intercepted API requests; never use real credits. */
export async function pdfContextChecks({page,session,workerSession,extensionOrigin,check,loadFile}) {
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,label)=>{for(let i=0;i<180;i++){if(await fn())return;await pause(80);}throw Error(label);};
  const control=code=>page.evaluate(`(()=>{const sh=document.getElementById('ezr-root').shadowRoot;${code}})()`);
  let options,popup; const calls=[];
  const off=session.on('Fetch.requestPaused',async event=>{
    if(!event.request.url.startsWith('https://api.deepseek.com/'))return;
    const models=event.request.url.endsWith('/models');
    const body=models?null:JSON.parse(event.request.postData);calls.push({models,body});
    const analysis=body?.messages[0].content.includes('语境分析器');
    const data=models?{data:[{id:'deepseek-fixture-2027',name:'Fixture Model'}]}:{choices:[{message:{content:analysis?JSON.stringify({topic:'PDF context',tone:'clear',terms:[]}):'模拟译文'}}]};
    await session.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(data)).toString('base64')},workerSession);
  },workerSession);
  try {
    await session.send('Fetch.enable',{patterns:[{urlPattern:'https://api.mymemory.translated.net/*'},{urlPattern:'https://api.deepseek.com/*'}]},workerSession);
    options=await CdpPage.attach(session,{url:extensionOrigin+'/pages/options.html'});
    await until(()=>options.evaluate("!!document.getElementById('translation-save')&&!document.getElementById('translation-save').disabled"),'模型设置页未准备好');
    await options.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:save',apiKey:'sk-pdf-context-test-only',config:{enabled:true,bubbleCards:false,explanations:false,wordCards:false,preload:false,source:'en',provider:'deepseek'}})");
    await options.evaluate("location.reload()");
    await until(()=>options.evaluate("!!document.querySelector('#translation-model option[value=deepseek-fixture-2027]')&&!document.getElementById('translation-save').disabled"),'API 模型列表未加载');
    await options.evaluate("document.getElementById('translation-model').value='deepseek-fixture-2027';document.getElementById('translation-save').click()");
    await until(()=>options.evaluate("document.getElementById('translation-status').textContent.includes('已保存')"),'API 模型未保存');
    check('模型选择仅列出 API 返回值并允许保存新增模型',await options.evaluate("[...document.querySelectorAll('#translation-model option')].filter(o=>o.value).map(o=>o.value).join(',')==='deepseek-fixture-2027'&&document.getElementById('translation-model').value==='deepseek-fixture-2027'"));
    await loadFile();await session.send('Page.bringToFront',{},page.sessionId);
    await control("sh.querySelector('.ezr-full-close').click();sh.querySelector('.ezr-btn-close').click()");
    const target=await session.send('Target.createTarget',{url:extensionOrigin+'/pages/popup.html',background:true});
    popup=await CdpPage.attach(session,{targetId:target.targetId});
    await until(()=>popup.evaluate("!!document.getElementById('primary')&&!document.getElementById('primary').disabled"),'PDF 的重新打开入口仍置灰');
    check('PDF 两栏关闭后弹窗仍可重新打开',await popup.evaluate("document.getElementById('primary-label').textContent==='打开 PDF 工具栏'"));
    await popup.evaluate("document.getElementById('primary').click()").catch(()=>{});
    await until(()=>control("return !sh.querySelector('.ezr-toolbar').hidden"),'PDF 工具栏未恢复');
    const select=async(term,pageNumber=1)=>{
      await page.evaluate(`(()=>{const input=document.getElementById('pdf-page');input.value=${pageNumber};input.dispatchEvent(new Event('change'))})()`);
      await until(()=>page.evaluate(`!![...document.querySelectorAll('.page[data-page-number="${pageNumber}"] .textLayer span')].find(n=>n.textContent.includes(${JSON.stringify(term)}))`),'PDF 选区文字层未渲染');
      await page.evaluate(`(()=>{const span=[...document.querySelectorAll('.page[data-page-number="${pageNumber}"] .textLayer span')].find(n=>n.textContent.includes(${JSON.stringify(term)})),walker=document.createTreeWalker(span,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const start=node.data.indexOf(${JSON.stringify(term)});if(start<0)continue;const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+${term.length});const selection=getSelection();selection.removeAllRanges();selection.addRange(range);break;}})()`);
      await until(()=>control(`return [...sh.querySelectorAll('.ezr-original-selection .ezr-translation')].some(p=>!p.hidden&&p.querySelector('.ezr-translation-source').textContent===${JSON.stringify(term)})`),'PDF 划词弹窗未显示');
      await control("sh.querySelector('.ezr-original-selection .ezr-translate-deepseek').click()");
      await until(()=>control("return sh.querySelector('.ezr-original-selection .ezr-translation-result').textContent==='模拟译文'"),'PDF 划词翻译未完成');
    };
    await select('First');await select('Third');await select('Another',2);
    const analyses=()=>calls.filter(call=>call.body?.messages[0].content.includes('语境分析器'));
    check('PDF 不同文本框和跨页划词只分析一次语境',analyses().length===1);
    check('翻译实际发送 API 返回并选中的模型',calls.filter(call=>call.body).every(call=>call.body.model==='deepseek-fixture-2027'));
    await control("sh.querySelector('.ezr-btn-translation').click();sh.querySelector('.ezr-full-start').click()");
    await until(()=>control("return sh.querySelector('.ezr-full-stop').hidden&&/已翻译/.test(sh.querySelector('.ezr-full-status').textContent)"),'PDF 全文翻译未完成');
    check('PDF 全文翻译复用划词已经分析的语境',analyses().length===1);
    await loadFile();await select('First');
    check('更换 PDF 后重新分析新文档语境',analyses().length===2);
  } finally {
    await popup?.close().catch(()=>{});
    if(options){await options.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:save',apiKey:'',config:{provider:'free',enabled:true,bubbleCards:false,source:'en',target:'zh-CN'}})").catch(()=>{});await options.close();}
    off();await session.send('Fetch.enable',{patterns:[{urlPattern:'https://api.mymemory.translated.net/*'}]},workerSession);
    await loadFile();await session.send('Page.bringToFront',{},page.sessionId);
  }
}
