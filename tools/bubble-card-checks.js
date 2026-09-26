import path from 'node:path';
import { CdpPage } from './cdp.js';

/** Exercises the real extension with deterministic intercepted provider responses. */
export async function bubbleCardChecks(page, iso, check, artifacts) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sh = code => iso(`(()=>{const sh=document.getElementById('ezr-root').shadowRoot;${code}})()`);
  const until = async (fn, label) => { for (let i=0;i<160;i++) { if (await fn()) return; await pause(60); } throw new Error(label); };
  const extensionId = await iso('chrome.runtime.id'), session = page.session;
  const targets = await session.send('Target.getTargets');
  const worker = targets.targetInfos.find(item => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${extensionId}/`));
  const { sessionId } = await session.send('Target.attachToTarget', { targetId:worker.targetId, flatten:true });
  const calls = []; let options, fail = false, delay = 0;
  const plain = text => text.replace(/\bbank\b/gi, '银行').replace(/\bfinancial\b/gi, '金融').replace(/\bdeposits\b/gi, '存款');
  const off = session.on('Fetch.requestPaused', async event => {
    const body = event.request.postData ? JSON.parse(event.request.postData) : null;
    const payload = body ? JSON.parse(body.messages.at(-1).content) : null;
    calls.push(body ? { body, payload } : { free:true });
    let content;
    if (!body) content = plain(new URL(event.request.url).searchParams.get('q'));
    else if (payload.segments) content = JSON.stringify({ segments:payload.segments.map(segment => ({ id:segment.id, text:plain(segment.text), words:[
      { term:'bank', translatedTerm:'银行', translation:'银行', meaning:'管理存款和贷款的机构。', usage:'open a bank account：开设银行账户' },
      { term:'financial', translatedTerm:'金融', translation:'金融的', meaning:'与资金管理有关。', usage:'financial services：金融服务' },
    ] })) });
    else if (body.response_format) content = JSON.stringify({ topic:'Banking', tone:'Clear', terms:[] });
    else content = plain(payload.text);
    const waiting = delay; delay = 0; if (waiting) await pause(waiting);
    const code = fail ? 429 : 200; fail = false;
    const data = body ? { choices:[{ finish_reason:'stop', message:{ content } }] } : { responseStatus:200, responseData:{ translatedText:content } };
    await session.send('Fetch.fulfillRequest', { requestId:event.requestId, responseCode:code,
      responseHeaders:[{ name:'Content-Type', value:'application/json' }], body:Buffer.from(JSON.stringify(data)).toString('base64') }, sessionId).catch(()=>{});
  }, sessionId);
  await session.send('Fetch.enable', { patterns:[{ urlPattern:'https://api.deepseek.com/*' }, { urlPattern:'https://api.mymemory.translated.net/*' }] }, sessionId);
  const complete = () => until(() => sh("return sh.querySelector('.ezr-full-stop').hidden && /已翻译/.test(sh.querySelector('.ezr-full-status').textContent);"), '全文翻译未完成');
  const count = () => calls.length;
  const visibleDot = term => sh(`return [...sh.querySelectorAll('.ezr-bubble-dot')].some(node=>!node.hidden&&node.dataset.term===${JSON.stringify(term)});`);
  const openDot = term => sh(`[...sh.querySelectorAll('.ezr-bubble-dot')].find(node=>!node.hidden&&node.dataset.term===${JSON.stringify(term)}).click();`);
  try {
    options = await CdpPage.attach(session, { url:`chrome-extension://${extensionId}/pages/options.html` });
    await until(() => options.evaluate("document.getElementById('translation-level')?.options.length>0"), '设置页未加载');
    const configured = await options.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:save',apiKey:'sk-bubble-test-only',config:{enabled:false,bubbleCards:true,provider:'deepseek',source:'en',target:'zh-CN',level:'B1',explanations:true}})");
    if (!configured.ok) throw new Error(configured.message);
    await session.send('Page.bringToFront', {}, page.sessionId);
    await iso("chrome.runtime.sendMessage({type:'ezr:translation:cards-save',card:{term:'bank',translation:'银行',sourceLanguage:'en',targetLanguage:'zh-CN'}})");
    await iso("window.__ezrSend({type:'ezr:full-translation'})"); await pause(200);
    await sh("sh.querySelector('.ezr-btn-original').click();");
    await until(() => sh("return sh.querySelector('.ezr-full-bubbles').checked;"), '词卡开关未同步');
    check('划词关闭时泡泡词卡开关独立可用，位于翻译设置左侧', await sh("const b=sh.querySelector('.ezr-full-bubble-toggle'),s=sh.querySelector('.ezr-full-settings');return !sh.querySelector('.ezr-full-selection').checked&&!sh.querySelector('.ezr-full-bubbles').disabled&&b.nextElementSibling===s;"));
    await sh("sh.querySelector('.ezr-full-start').click();"); await complete(); await pause(250);
    check('泡泡模式每批最多四段，译文和词卡同一次请求且不逐词调用', calls.length>0 && calls.every(call=>call.payload?.segments?.length<=4) && calls.some(call=>call.payload.segments.length>1));
    await page.evaluate("document.getElementById('first').scrollIntoView({block:'center'})"); await pause(180);
    check('生词本中的 bank 显示黄点，financial 显示绿点', await sh("return [...sh.querySelectorAll('.ezr-bubble-dot')].some(d=>!d.hidden&&d.dataset.term==='bank'&&d.dataset.saved==='true')&&[...sh.querySelectorAll('.ezr-bubble-dot')].some(d=>!d.hidden&&d.dataset.term==='financial'&&d.dataset.saved==='false');"));
    const before = count(); await openDot('financial');
    check('点击圆点打开缓存词卡，位置与划词浮窗规则相同', await sh("const p=sh.querySelector('.ezr-bubble-card'),r=p.getBoundingClientRect();return !p.hidden&&p.textContent.includes('金融的')&&r.left>=10&&r.right<=innerWidth-9&&r.bottom<=innerHeight-9;") && count()===before);
    check('上方设置按钮增宽并与翻译设置左右对齐', await sh("const a=sh.querySelector('.ezr-btn-settings').getBoundingClientRect(),b=sh.querySelector('.ezr-full-settings').getBoundingClientRect();return Math.abs(a.left-b.left)<1&&Math.abs(a.right-b.right)<1;"));
    check('固定工具栏遮挡的文字不显示圆点', await sh("const bottom=sh.querySelector('.ezr-toolbar-slot-top').getBoundingClientRect().bottom;return [...sh.querySelectorAll('.ezr-bubble-dot')].filter(d=>!d.hidden).every(d=>d.getBoundingClientRect().top>=bottom);"));
    await page.screenshot({ path:path.join(artifacts, 'bubble-cards-desktop.png') });
    await sh("sh.querySelector('.ezr-bubble-minimize').click();");
    check('最小化保留绿点且不请求网络', await sh("return sh.querySelector('.ezr-bubble-card').hidden;") && await visibleDot('financial') && count()===before);
    // A real DOM range in the original page opens the existing cache with selection translation off.
    await page.evaluate("(()=>{const p=document.getElementById('first'),n=p.firstChild,i=n.data.indexOf('金融');const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+2);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));})()"); await pause(180);
    check('划词翻译关闭后选中带词卡的译文仍打开泡泡', await sh("return !sh.querySelector('.ezr-bubble-card').hidden&&[...sh.querySelectorAll('.ezr-translation')].every(p=>p.hidden);") && count()===before);
    await sh("sh.querySelector('.ezr-bubble-save').click();"); await until(() => sh("return sh.querySelector('.ezr-bubble-save').textContent==='已加入生词本';"), '生词本保存失败'); await pause(100);
    check('保存后所有同词圆点实时变黄', await sh("return [...sh.querySelectorAll('.ezr-bubble-dot')].filter(d=>d.dataset.term==='financial').every(d=>d.dataset.saved==='true');"));
    await page.setViewport(390, 844); await pause(220); await page.evaluate("document.getElementById('first').scrollIntoView({block:'center'})"); await pause(120); await openDot('bank');
    check('窄屏泡泡和两行设置入口保持可见，不横向溢出', await sh("const p=sh.querySelector('.ezr-bubble-card').getBoundingClientRect(),b=sh.querySelector('.ezr-full-settings').getBoundingClientRect(),a=sh.querySelector('.ezr-btn-settings').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth&&p.bottom<=innerHeight&&b.right<=innerWidth&&Math.abs(a.right-b.right)<1;"));
    check('窄屏卡片避让固定工具栏', await sh("return sh.querySelector('.ezr-bubble-card').getBoundingClientRect().top>=sh.querySelector('.ezr-toolbar-slot-top').getBoundingClientRect().bottom;"));
    await page.screenshot({ path:path.join(artifacts, 'bubble-cards-mobile.png') });
    await page.setViewport(1280, 900); await pause(120); await openDot('financial'); await sh("sh.querySelector('.ezr-bubble-close').click();"); await pause(100);
    check('关闭词卡移除同词圆点，但保留生词本记录', !(await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=financial]');")) && await iso("chrome.storage.local.get('ezr:wordbook').then(b=>b['ezr:wordbook'].some(c=>c.term==='financial'))"));
    await sh("sh.querySelector('.ezr-full-start').click();sh.querySelector('.ezr-full-start').click();"); await complete(); await pause(100);
    check('切回原文再翻译不复活已关闭词卡，也不重发请求', !(await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=financial]');")) && count()===before);
    await sh("sh.querySelector('.ezr-btn-original').click();"); await pause(250);
    check('简洁阅读重新锚定原文词卡', await sh("return !sh.host.hasAttribute('data-ezr-original')&&!!sh.querySelector('.ezr-bubble-dot[data-term=bank]');"));
    const cached = count(); await sh("sh.querySelector('.ezr-full-bilingual').click();"); await pause(100);
    check('仅译文视图保持词卡而不另发请求', await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=bank]');") && count()===cached);
    await sh("sh.querySelector('.ezr-full-bubbles').click();"); await pause(160);
    check('关闭泡泡工具隐藏全部圆点', await sh("return sh.querySelector('.ezr-bubbles').hidden;"));
    await sh("sh.querySelector('.ezr-full-bubbles').click();"); await complete(); await pause(130);
    check('重开泡泡工具复用缓存并保留逐词关闭状态', !(await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=financial]');")) && count()===cached);
    // Free service uses local wordbook cards and must never fall back to the paid model.
    await iso("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{provider:'free'}})"); await pause(120);
    const freeStart = count(); await sh("sh.querySelector('.ezr-full-start').click();"); await complete(); await pause(120);
    check('免费翻译泡泡只复用本地词卡，无付费请求', calls.slice(freeStart).every(call=>call.free) && await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=bank]');"));
    await iso("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{provider:'deepseek',target:'fr',bubbleCards:true}})");
    await pause(120); fail = true;
    await sh("sh.querySelector('.ezr-full-start').click();"); await complete();
    check('泡泡翻译请求失败保留失败片段',await sh("return !sh.querySelector('.ezr-full-retry').hidden;"));
    await sh("sh.querySelector('.ezr-full-bubbles').click();"); await pause(160);
    check('关闭泡泡词卡仍可重试尚无译文的片段',await sh("return !sh.querySelector('.ezr-full-retry').hidden;"));
    const retryRequests = count();
    await sh("sh.querySelector('.ezr-full-retry').click();"); await complete();
    check('关闭泡泡后用普通翻译补齐失败片段',count()>retryRequests && await sh("return sh.querySelector('.ezr-full-retry').hidden;"));
    await iso('window.__ezr.close()');
    check('关闭阅读器移除词卡层并恢复原网页', await page.evaluate("!document.getElementById('ezr-root')&&document.getElementById('first').textContent.startsWith('The bank')"));
  } finally {
    if (options) {
      await options.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:save',apiKey:'',config:{enabled:true,bubbleCards:false,provider:'free',source:'auto',target:'zh-CN'}})").catch(()=>{});
      await options.evaluate("chrome.storage.local.remove('ezr:wordbook')").catch(()=>{}); await options.close();
    }
    await session.send('Fetch.disable', {}, sessionId).catch(()=>{}); off();
  }
}
