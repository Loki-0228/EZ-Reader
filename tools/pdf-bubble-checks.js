import path from 'node:path';
import { CdpPage } from './cdp.js';

/** Original PDF text layers and translated overlays must anchor the same cached words. */
export async function pdfBubbleChecks({ page, session, workerSession, extensionOrigin, control, check, loadFile, artifacts }) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (fn, label) => { for (let i=0;i<200;i++) { if (await fn()) return; await pause(60); } throw new Error('PDF 泡泡等待超时：' + label); };
  const calls = [], meanings = { First:'首个', Second:'第二', Third:'第三', Another:'另一' };
  let fail = true, options;
  const off = session.on('Fetch.requestPaused', async event => {
    if (!event.request.url.startsWith('https://api.deepseek.com/')) return;
    const body = JSON.parse(event.request.postData), payload = JSON.parse(body.messages.at(-1).content); calls.push({body,payload});
    const segments = payload.segments.map(segment => {
      const term = Object.keys(meanings).find(term => segment.text.includes(term));
      return { id:segment.id, text:segment.existingTranslation || segment.text.replace(term,meanings[term]),
        words:term ? [{ term, translation:meanings[term], translatedTerm:meanings[term], meaning:'当前语境中的词义。' }] : [] };
    });
    const status = fail ? 429 : 200; fail = false;
    await session.send('Fetch.fulfillRequest', { requestId:event.requestId, responseCode:status,
      responseHeaders:[{name:'Content-Type',value:'application/json'}], body:Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify({segments})}}]})).toString('base64') }, workerSession);
  }, workerSession);
  try {
    await session.send('Fetch.enable',{patterns:[{urlPattern:'https://api.mymemory.translated.net/*'},{urlPattern:'https://api.deepseek.com/*'}]},workerSession);
    options = await CdpPage.attach(session,{url:extensionOrigin+'/pages/options.html'});
    await until(()=>options.evaluate("document.getElementById('translation-level')?.options.length>0"),'设置页');
    await options.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:save',apiKey:'sk-pdf-bubbles-test',config:{provider:'deepseek',source:'en',target:'zh-CN',enabled:false,bubbleCards:false,level:'B1'}})");
    await loadFile(); await page.setViewport(1280,960);
    await session.send('Page.bringToFront',{},page.sessionId);
    await control("if(sh.querySelector('.ezr-full-bar').hidden)sh.querySelector('.ezr-btn-translation').click();sh.querySelector('.ezr-full-mode input[value=bubbles]').click()");
    await until(()=>control("return sh.querySelector('.ezr-full-stop').hidden&&sh.querySelector('.ezr-full-retry').textContent.startsWith('重试失败词卡')&&!sh.querySelector('.ezr-full-retry').hidden"),'独立词卡失败重试');
    check('PDF 独立词卡失败保留原文，提供词卡重试入口',await page.evaluate("document.querySelectorAll('.ezr-pdf-text').length===0")&&await control("return sh.querySelector('.ezr-full-start').textContent==='全文翻译'"));
    await control("sh.querySelector('.ezr-full-retry').click()");
    await until(()=>control("return sh.querySelector('.ezr-full-stop').hidden&&/词卡已就绪/.test(sh.querySelector('.ezr-full-status').textContent)&&sh.querySelector('.ezr-full-retry').hidden"),'词卡重试完成');
    await until(()=>control("return [...sh.querySelectorAll('.ezr-bubble-dot')].some(d=>!d.hidden&&d.dataset.term==='First')"),'PDF 原文泡泡锚点');
    check('PDF 原文可独立显示泡泡且只请求词卡',calls.every(call=>call.body.messages[0].content.includes('不翻译全文或整段'))&&await page.evaluate("document.querySelectorAll('.ezr-pdf-text').length===0"));
    const count = calls.length;
    await control("sh.querySelector('.ezr-bubble-dot[data-term=First]').click();sh.querySelector('.ezr-bubble-expand-all').click()");
    check('PDF 词卡内支持全部展开且悬浮提示包含原文和译文',await control("return !sh.querySelector('.ezr-bubble-all').hidden&&sh.querySelector('.ezr-bubble-dot[data-term=First]').title==='First：首个'"));
    await control("sh.querySelector('.ezr-bubble-all .ezr-bubble-collapse-all').click();sh.querySelector('.ezr-full-start').click()");
    await until(()=>control("return sh.querySelector('.ezr-full-stop').hidden&&/已翻译/.test(sh.querySelector('.ezr-full-status').textContent)"),'全文翻译');
    await until(()=>page.evaluate("document.querySelector('.ezr-pdf-text')?.textContent.includes('首个')"),'PDF 译文绘制');
    await until(()=>control("return [...sh.querySelectorAll('.ezr-bubble-dot')].some(d=>!d.hidden&&d.dataset.term==='First')"),'PDF 译文泡泡');
    check('PDF 组合请求改用全文提示词并沿用原文词卡',calls.length>count&&calls.slice(count).every(call=>call.body.messages[0].content.includes('完成全文翻译')&&call.payload.segments.some(segment=>segment.existingWords.length)));
    await page.screenshot({path:path.join(artifacts,'bubble-translated.png')});
    const translatedCount = calls.length;
    await control("sh.querySelector('.ezr-full-start').click()");
    await until(()=>control("return sh.querySelector('.ezr-full-stop').hidden&&[...sh.querySelectorAll('.ezr-bubble-dot')].some(d=>!d.hidden&&d.dataset.term==='First')"),'还原原文泡泡');
    check('PDF 切回原文保留泡泡且不重复请求',calls.length===translatedCount&&await page.evaluate("document.querySelectorAll('.ezr-pdf-text').length===0"));
    await page.screenshot({path:path.join(artifacts,'bubble-original.png')});
  } finally {
    if (options) { await options.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:save',apiKey:'',config:{enabled:true,bubbleCards:false,provider:'free',source:'en',target:'zh-CN'}})").catch(()=>{}); await options.close(); }
    off(); await session.send('Fetch.enable',{patterns:[{urlPattern:'https://api.mymemory.translated.net/*'}]},workerSession);
  }
}
