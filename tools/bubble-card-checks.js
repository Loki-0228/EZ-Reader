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
  const cardsComplete = () => until(() => sh("return sh.querySelector('.ezr-full-stop').hidden && /词卡已就绪/.test(sh.querySelector('.ezr-full-status').textContent);"), '独立词卡未完成');
  const count = () => calls.length;
  const visibleDot = term => sh(`return [...sh.querySelectorAll('.ezr-bubble-dot')].some(node=>!node.hidden&&node.dataset.term===${JSON.stringify(term)});`);
  const openDot = term => sh(`[...sh.querySelectorAll('.ezr-bubble-dot')].find(node=>!node.hidden&&node.dataset.term===${JSON.stringify(term)}).click();`);
  const mode = value => sh(`sh.querySelector('.ezr-full-mode input[value="${value}"]').click();`);
  const savedMode = value => until(() => iso(`chrome.runtime.sendMessage({type:'ezr:translation:config'}).then(r=>r.config.enabled===${value==='selection'}&&r.config.bubbleCards===${value==='bubbles'})`), '词卡模式未保存');
  try {
    options = await CdpPage.attach(session, { url:`chrome-extension://${extensionId}/pages/options.html` });
    await until(() => options.evaluate("document.getElementById('translation-level')?.options.length>0"), '设置页未加载');
    const configured = await options.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:save',apiKey:'sk-bubble-test-only',config:{enabled:true,bubbleCards:false,provider:'deepseek',source:'en',target:'zh-CN',level:'B1',explanations:true}})");
    if (!configured.ok) throw new Error(configured.message);
    await session.send('Page.bringToFront', {}, page.sessionId);
    await iso("chrome.runtime.sendMessage({type:'ezr:translation:cards-save',card:{term:'bank',translation:'银行',sourceLanguage:'en',targetLanguage:'zh-CN'}})");
    await iso("window.__ezrSend({type:'ezr:full-translation'})"); await pause(200);
    await sh("sh.querySelector('.ezr-btn-original').click();");
    await until(() => sh("return sh.querySelector('.ezr-full-mode input[value=selection]').checked;"), '词卡模式未同步');
    check('三档模式互斥且位于翻译设置左侧', await sh("const m=sh.querySelector('.ezr-full-mode');return m.querySelectorAll('input').length===3&&m.querySelectorAll(':checked').length===1&&m.nextElementSibling===sh.querySelector('.ezr-full-settings');"));
    await sh("sh.querySelector('.ezr-btn-settings').click();");
    await until(()=>sh("return !sh.querySelector('.ezr-settings .ezr-translation-mode input[value=bubbles]').disabled;"),'阅读设置未准备好');
    await sh("sh.querySelector('.ezr-settings .ezr-translation-mode input[value=bubbles]').click();"); await savedMode('bubbles'); await pause(100);
    await cardsComplete(); await pause(150);
    check('原文单独开启泡泡会生成词卡，保留原文和全文翻译入口',await sh("return sh.querySelector('.ezr-full-mode input[value=bubbles]').checked&&sh.querySelector('.ezr-full-start').textContent==='全文翻译'&&!!sh.querySelector('.ezr-bubble-dot[data-term=financial]');")&&await page.evaluate("document.getElementById('first').textContent.startsWith('The bank')")&&count()>0);
    const standaloneCalls = [...calls];
    check('原文泡泡采用独立提示词，不要求全文译文或语境摘要',standaloneCalls.every(call=>call.payload.segments&&!Object.hasOwn(call.payload.segments[0],'existingTranslation')&&call.body.messages[0].content.includes('不翻译全文或整段')));
    await sh("sh.querySelector('.ezr-settings .ezr-translation-mode input[value=selection]').click();"); await savedMode('selection'); await pause(100);
    await sh("sh.querySelector('.ezr-settings-close').click();");
    await sh("sh.querySelector('.ezr-full-start').click();"); await complete(); await pause(250);
    const plainCount=count(), originalTranslation=await page.evaluate("document.getElementById('first').textContent");
    await sh("sh.querySelector('.ezr-full-mode input[value=selection]').focus();");
    await session.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},page.sessionId);
    await session.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},page.sessionId);
    await savedMode('off'); await pause(140);
    check('三档开关支持方向键且只有一个选中项',await sh("return sh.querySelector('.ezr-full-mode input[value=off]').checked&&sh.querySelectorAll('.ezr-full-mode :checked').length===1;"));
    check('中间档同时关闭划词和泡泡，保留全文译文且不请求网络', await sh("return sh.querySelector('.ezr-bubbles').hidden&&[...sh.querySelectorAll('.ezr-translation')].every(p=>p.hidden);")&&count()===plainCount&&await page.evaluate("document.getElementById('first').textContent")===originalTranslation);
    await mode('selection'); await savedMode('selection'); await pause(100);
    await mode('bubbles'); await savedMode('bubbles'); await complete(); await pause(200);
    const cardCalls=calls.slice(plainCount);
    check('从划词直接切到泡泡会补充词卡并保留已有译文', cardCalls.length>0&&cardCalls.every(call=>call.payload.segments.every(s=>s.existingTranslation))&&await page.evaluate("document.getElementById('first').textContent")===originalTranslation);
    check('泡泡模式每批最多四段，译文和词卡同一次请求且不逐词调用', cardCalls.every(call=>call.payload?.segments?.length<=4) && cardCalls.some(call=>call.payload.segments.length>1));
    check('组合翻译沿用原文词卡，并采用另一套提示词',cardCalls.some(call=>call.payload.segments.some(s=>s.existingWords.length))&&cardCalls.every(call=>call.body.messages[0].content!==standaloneCalls[0].body.messages[0].content));
    await mode('selection'); await savedMode('selection'); await pause(140);
    check('从泡泡切回划词会立即隐藏圆点',await sh("return sh.querySelector('.ezr-bubbles').hidden&&sh.querySelector('.ezr-full-mode input[value=selection]').checked;"));
    const settingsCount=count();
    await options.evaluate("document.querySelector('#translation-mode input[value=bubbles]').click();document.getElementById('translation-level').value='B2';document.getElementById('translation-save').click();");
    await savedMode('bubbles'); await session.send('Page.bringToFront', {}, page.sessionId);
    await until(()=>sh("return sh.querySelector('.ezr-full-level').value==='B2';"),'设置页模式没有同步');
    await complete(); await pause(180);
    check('设置页开启泡泡并修改水平后自动补充词卡，保持译文',count()>settingsCount&&calls.slice(settingsCount).every(call=>call.payload.segments.every(s=>s.existingTranslation))&&await page.evaluate("document.getElementById('first').textContent")===originalTranslation);
    await page.evaluate("document.getElementById('first').scrollIntoView({block:'center'})"); await pause(180);
    check('生词本中的 bank 显示黄点，financial 显示绿点', await sh("return [...sh.querySelectorAll('.ezr-bubble-dot')].some(d=>!d.hidden&&d.dataset.term==='bank'&&d.dataset.saved==='true')&&[...sh.querySelectorAll('.ezr-bubble-dot')].some(d=>!d.hidden&&d.dataset.term==='financial'&&d.dataset.saved==='false');"));
    const before = count(); await openDot('financial');
    check('泡泡有描边、70% 不透明度，悬浮提示为原文：译文',await sh("const d=sh.querySelector('.ezr-bubble-dot[data-term=financial]'),s=getComputedStyle(d,'::before');return s.opacity==='0.7'&&s.borderTopWidth==='1px'&&d.title==='financial：金融的';"));
    check('点击圆点打开缓存词卡，位置与划词浮窗规则相同', await sh("const p=sh.querySelector('.ezr-bubble-card'),r=p.getBoundingClientRect();return !p.hidden&&p.textContent.includes('金融的')&&r.left>=10&&r.right<=innerWidth-9&&r.bottom<=innerHeight-9;") && count()===before);
    check('上方设置按钮增宽并与翻译设置左右对齐', await sh("const a=sh.querySelector('.ezr-btn-settings').getBoundingClientRect(),b=sh.querySelector('.ezr-full-settings').getBoundingClientRect();return Math.abs(a.left-b.left)<1&&Math.abs(a.right-b.right)<1;"));
    check('固定工具栏遮挡的文字不显示圆点', await sh("const bottom=sh.querySelector('.ezr-toolbar-slot-top').getBoundingClientRect().bottom;return [...sh.querySelectorAll('.ezr-bubble-dot')].filter(d=>!d.hidden).every(d=>d.getBoundingClientRect().top>=bottom);"));
    await page.screenshot({ path:path.join(artifacts, 'bubble-cards-desktop.png') });
    await sh("sh.querySelector('.ezr-bubble-expand-all').click();");
    check('每张泡泡卡均可全部展开、全部收起，展开按词去重且不请求网络',await sh("const p=sh.querySelector('.ezr-bubble-all'),cards=[...p.querySelectorAll('.ezr-bubble-card')];return !p.hidden&&cards.length>=2&&cards.every(c=>c.querySelector('.ezr-bubble-expand-all')&&c.querySelector('.ezr-bubble-collapse-all'))&&new Set(cards.map(c=>c.querySelector('strong').textContent)).size===cards.length;")&&count()===before);
    await sh("sh.querySelector('.ezr-bubble-all .ezr-bubble-collapse-all').click();");
    check('全部收起保留圆点与词卡缓存',await sh("return sh.querySelector('.ezr-bubble-all').hidden&&sh.querySelector('.ezr-bubble-card').hidden;")&&await visibleDot('financial')&&count()===before);
    await openDot('financial');
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
    await sh("sh.querySelector('.ezr-bubble-expand-all').click();");
    check('窄屏全部展开支持滚动，卡片不溢出并避让工具栏',await sh("const p=sh.querySelector('.ezr-bubble-all'),r=p.getBoundingClientRect();return !p.hidden&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&r.top>=sh.querySelector('.ezr-toolbar-slot-top').getBoundingClientRect().bottom&&p.scrollWidth===p.clientWidth;"));
    await page.screenshot({ path:path.join(artifacts, 'bubble-cards-all-mobile.png') });
    await sh("sh.querySelector('.ezr-bubble-all .ezr-bubble-collapse-all').click();");
    await page.setViewport(1280, 900); await pause(120); await openDot('financial'); await sh("sh.querySelector('.ezr-bubble-close').click();"); await pause(100);
    check('关闭词卡移除同词圆点，但保留生词本记录', !(await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=financial]');")) && await iso("chrome.storage.local.get('ezr:wordbook').then(b=>b['ezr:wordbook'].some(c=>c.term==='financial'))"));
    await sh("sh.querySelector('.ezr-full-start').click();"); await cardsComplete(); await pause(100);
    check('显示原文仍保留泡泡，并复用组合翻译的词卡',await page.evaluate("document.getElementById('first').textContent.startsWith('The bank')")&&await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=bank]');")&&count()===before);
    await sh("sh.querySelector('.ezr-full-start').click();"); await complete(); await pause(100);
    check('切回原文再翻译不复活已关闭词卡，也不重发请求', !(await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=financial]');")) && count()===before);
    await sh("sh.querySelector('.ezr-btn-original').click();"); await pause(250);
    check('简洁阅读重新锚定原文词卡', await sh("return !sh.host.hasAttribute('data-ezr-original')&&!!sh.querySelector('.ezr-bubble-dot[data-term=bank]');"));
    const cached = count(); await sh("sh.querySelector('.ezr-full-bilingual').click();"); await pause(100);
    check('仅译文视图保持词卡而不另发请求', await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=bank]');") && count()===cached);
    await mode('off'); await savedMode('off'); await pause(160);
    check('关闭泡泡工具隐藏全部圆点', await sh("return sh.querySelector('.ezr-bubbles').hidden;"));
    await mode('bubbles'); await savedMode('bubbles'); await complete(); await pause(130);
    check('重开泡泡工具复用缓存并保留逐词关闭状态', !(await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=financial]');")) && count()===cached);
    // Free service uses local wordbook cards and must never fall back to the paid model.
    await iso("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{provider:'free'}})"); await pause(120);
    const freeStart = count(); await sh("sh.querySelector('.ezr-full-start').click();"); await complete(); await pause(120);
    check('免费翻译泡泡只复用本地词卡，无付费请求', calls.slice(freeStart).every(call=>call.free) && await sh("return !!sh.querySelector('.ezr-bubble-dot[data-term=bank]');"));
    await iso("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{provider:'deepseek',target:'fr',bubbleCards:true}})");
    await cardsComplete(); fail = true;
    await sh("sh.querySelector('.ezr-full-start').click();"); await complete();
    check('泡泡翻译请求失败保留失败片段',await sh("return !sh.querySelector('.ezr-full-retry').hidden;"));
    await mode('off'); await savedMode('off'); await pause(160);
    check('关闭泡泡词卡仍可重试尚无译文的片段',await sh("return !sh.querySelector('.ezr-full-retry').hidden;"));
    const retryRequests = count();
    await sh("sh.querySelector('.ezr-full-retry').click();"); await complete();
    check('关闭泡泡后用普通翻译补齐失败片段',count()>retryRequests && await sh("return sh.querySelector('.ezr-full-retry').hidden;"));
    const completedText=await sh("return sh.querySelector('.ezr-article').textContent;");
    await iso("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{target:'de',bubbleCards:true}})"); await savedMode('bubbles');
    await cardsComplete();
    const delayedStart=count(); delay=600;
    await sh("sh.querySelector('.ezr-full-start').click();");
    await until(()=>count()>delayedStart,'未启动延迟请求');
    await mode('off'); await savedMode('off'); await pause(100);
    check('请求进行中切到关闭档立即隐藏词卡',await sh("return sh.querySelector('.ezr-bubbles').hidden;"));
    await complete(); await pause(120);
    check('关闭词卡后继续完成全文翻译，迟到响应不恢复词卡或继续请求词卡',calls.slice(delayedStart).filter(call=>call.payload?.segments).length===1&&await sh("return sh.querySelector('.ezr-bubbles').hidden&&sh.querySelector('.ezr-full-retry').hidden;")&&await sh("return sh.querySelector('.ezr-article').textContent;")===completedText);
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
