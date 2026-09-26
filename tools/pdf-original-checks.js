import path from 'node:path';

/** PDF formula protection: real rectangle input, byte-identical source pixels, no live API calls. */
export async function pdfOriginalChecks({ page, session, control, calls, check, loadFile, formulaPath, formulaBytes, artifacts, setFailure, delayRequest }) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (work, label) => { for (let i=0;i<200;i++) { if (await work()) return; await pause(60); } throw new Error('原文标记等待超时：' + label); };
  const complete = () => until(()=>control("return sh.querySelector('.ezr-full-stop').hidden && /已翻译|均已标记/.test(sh.querySelector('.ezr-full-status').textContent)"),'全文翻译');
  const click = async (x,y) => {
    await session.send('Input.dispatchMouseEvent',{ type:'mousePressed',x,y,button:'left',clickCount:1 },page.sessionId);
    await session.send('Input.dispatchMouseEvent',{ type:'mouseReleased',x,y,button:'left',clickCount:1 },page.sessionId);
  };
  const selectText = async text => {
    await page.evaluate(`[...document.querySelectorAll('.ezr-pdf-edit-box')].find(e=>e.dataset.fullText===${JSON.stringify(text)}).scrollIntoView({block:'center'})`);
    await pause(100);
    const p = await page.evaluate(`(()=>{const e=[...document.querySelectorAll('.ezr-pdf-edit-box')].find(e=>e.dataset.fullText===${JSON.stringify(text)});const r=e.getBoundingClientRect();return{x:r.x+Math.min(8,r.width/2),y:r.y+Math.min(8,r.height/2)}})()`);
    await click(p.x,p.y);
  };
  const edit = async () => { await page.evaluate("if(!window.__ezrPdfTranslation.state.editing)document.getElementById('pdf-batch-edit').click()"); await until(()=>page.evaluate('window.__ezrPdfTranslation.state.editing'),'编辑入口'); await pause(120); };
  const start = async () => { await control("if(sh.querySelector('.ezr-full-bar').hidden)sh.querySelector('.ezr-btn-translation').click();sh.querySelector('.ezr-full-start').click()"); await complete(); };
  await loadFile(formulaPath);
  await session.send('Page.bringToFront',{},page.sessionId);
  await page.evaluate("document.getElementById('pdf-fit').click()");
  const initialCalls = calls.length;
  await edit();
  const formula = await page.evaluate("[...document.querySelectorAll('.page[data-page-number=\"1\"] .ezr-pdf-edit-box')].filter(e=>/E = mc|^2$|123/.test(e.dataset.fullText)).map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.box,text:e.dataset.fullText,left:r.left,top:r.top,right:r.right,bottom:r.bottom}})");
  check('翻译前可选择公式、上标和纯数字文本框',formula.length===3 && calls.length===initialCalls);
  const rect = { left:Math.min(...formula.map(b=>b.left))-8, top:Math.min(...formula.map(b=>b.top))-8,
    right:Math.max(...formula.map(b=>b.right))+8, bottom:Math.max(...formula.map(b=>b.bottom))+8 };
  await session.send('Input.dispatchMouseEvent',{ type:'mousePressed',x:rect.left,y:rect.top,button:'left',clickCount:1 },page.sessionId);
  await session.send('Input.dispatchMouseEvent',{ type:'mouseMoved',x:rect.right,y:rect.bottom,buttons:1 },page.sessionId);
  await session.send('Input.dispatchMouseEvent',{ type:'mouseReleased',x:rect.right,y:rect.bottom,button:'left',clickCount:1 },page.sessionId);
  await page.evaluate("document.getElementById('pdf-edit-original').click()");
  check('拖动框选后批量标记原文，未发翻译请求',await page.evaluate('window.__ezrPdfTranslation.state.originals.length===3') && calls.length===initialCalls);
  check('仅选原文时字号与对齐禁用，取消标记可用',await page.evaluate("document.getElementById('pdf-edit-font-size').disabled && document.getElementById('pdf-edit-horizontal').disabled && !document.getElementById('pdf-edit-unmark').disabled"));
  await page.evaluate("document.getElementById('pdf-edit-done').click()");
  await start();
  await until(()=>page.evaluate("document.querySelectorAll('.page[data-page-number=\"1\"] .ezr-pdf-text').length===3"),'其余文本显示译文');
  check('全文请求跳过标记公式，其余文本框正常翻译',calls.slice(initialCalls).length===4 && !calls.slice(initialCalls).some(text=>/E = mc/.test(text)));
  await page.evaluate(`(async()=>{
    const {openPdfDocument}=await import(chrome.runtime.getURL('documents/parser.js'));
    const job=await openPdfDocument(new TextEncoder().encode(${JSON.stringify(formulaBytes)}));
    const pdf=await job.pdf.getPage(1),canvas=document.createElement('canvas'),viewport=pdf.getViewport({scale:2});canvas.width=viewport.width;canvas.height=viewport.height;
    await pdf.render({canvasContext:canvas.getContext('2d'),viewport,intent:'print',annotationMode:0}).promise;
    window.__originalPixels=canvas.getContext('2d').getImageData(80,550,280,145).data;await job.destroy();
  })()`);
  check('公式、上标和数字区域与 PDF 原始绘制逐像素一致',await page.evaluate("(()=>{const now=document.querySelector('.page[data-page-number=\"1\"] .ezr-pdf-surface canvas').getContext('2d').getImageData(80,550,280,145).data;return now.every((v,i)=>v===window.__originalPixels[i])})()"));
  await edit(); await selectText('First translated box');
  await page.evaluate("document.getElementById('pdf-edit-font-size').value=14;document.getElementById('pdf-edit-font-size').dispatchEvent(new Event('input'))");
  const beforeMark = calls.length;
  await page.evaluate("document.getElementById('pdf-edit-original').click()");
  await until(()=>page.evaluate("document.querySelectorAll('.page[data-page-number=\"1\"] .ezr-pdf-text').length===2"),'已译框切原文');
  check('已翻译文本框标记后显示原文且保留取消入口',calls.length===beforeMark && await page.evaluate("window.__ezrPdfTranslation.state.originals.length===4 && !document.getElementById('pdf-edit-unmark').disabled"));
  await page.evaluate("document.getElementById('pdf-edit-unmark').click()");
  await until(()=>page.evaluate("[...document.querySelectorAll('.ezr-pdf-text')].some(e=>e.dataset.fullText.includes('First')&&Number(e.dataset.fontSize)===14)"),'取消后复用译文字号');
  check('取消标记立即恢复缓存译文及原有字号，不重复请求',calls.length===beforeMark);
  await selectText('E = mc'); await page.evaluate("document.getElementById('pdf-edit-unmark').click()");
  check('未翻译公式取消标记后保持原文，不自动请求',calls.length===beforeMark && await page.evaluate('window.__ezrPdfTranslation.state.originals.length===2'));
  await page.evaluate("document.getElementById('pdf-edit-done').click()");
  await control("sh.querySelector('.ezr-full-start').click()"); await start();
  check('再次全文翻译只请求刚取消标记的公式',calls.length===beforeMark+1 && calls.at(-1)==='E = mc');
  await edit(); await selectText('E = mc'); await page.evaluate("document.getElementById('pdf-edit-original').click()");
  await until(()=>page.evaluate("document.querySelectorAll('.page[data-page-number=\"1\"] .ezr-pdf-text').length===3"),'重新保护公式');
  await page.screenshot({path:path.join(artifacts,'original-marks-desktop.png')});
  await page.setViewport(390,844); await page.evaluate("document.getElementById('pdf-fit').click()"); await pause(200);
  check('窄屏原文标记按钮不溢出',await page.evaluate("document.getElementById('pdf-edit-controls').getBoundingClientRect().right<=innerWidth && document.getElementById('pdf-edit-unmark').getBoundingClientRect().right<=innerWidth"));
  await page.screenshot({path:path.join(artifacts,'original-marks-mobile.png')});
  await page.setViewport(1280,960); await page.evaluate("document.getElementById('pdf-fit').click()");
  await page.evaluate("window.__markExport=window.open('about:blank');window.__ezrPdfTranslation.exportPreview(window.__markExport).then(r=>window.__markExportResult=r)");
  check('导出保留原文标记，不生成公式译文或编辑边框',await page.evaluate("window.__markExportResult.originals===3 && ![...window.__markExport.document.querySelectorAll('.ezr-pdf-text')].some(e=>e.dataset.fullText.includes('E = mc')) && !window.__markExport.document.querySelector('.ezr-pdf-edit-layer')"));
  await page.evaluate("window.__markExport.close()"); await session.send('Page.bringToFront',{},page.sessionId);
  await control("sh.querySelector('.ezr-full-start').click()"); await start();
  check('切换原文与译文、缩放后保留三个原文标记',await page.evaluate('window.__ezrPdfTranslation.state.originals.length===3'));
  // Turn a failed request into an explicit original; it must leave the retry queue.
  await loadFile(formulaPath); setFailure(true);
  await start();
  await edit(); await selectText('Second translated box');
  await page.evaluate("document.getElementById('pdf-edit-original').click()");
  check('失败文本框标记为原文后退出失败重试队列',await control("return sh.querySelector('.ezr-full-retry').hidden"));
  const failedCount=calls.length;
  await control("sh.querySelector('.ezr-full-start').click()"); await start();
  check('后续全文翻译不会重试已保护的失败片段',calls.length===failedCount);
  setFailure(false);
  await edit(); await selectText('Second translated box'); await page.evaluate("document.getElementById('pdf-edit-unmark').click()");
  check('取消失败项标记后恢复重试入口',await control("return !sh.querySelector('.ezr-full-retry').hidden"));
  await control("sh.querySelector('.ezr-full-retry').click()"); await complete();
  check('取消标记后重试只补该片段',calls.length===failedCount+1 && calls.at(-1)==='Second translated box');
  await loadFile(formulaPath); await edit(); await selectText('First translated box');
  const during=calls.length; delayRequest(650);
  await control("sh.querySelector('.ezr-btn-translation').click();sh.querySelector('.ezr-full-start').click()");
  await until(()=>Promise.resolve(calls.length>during),'在途请求');
  await page.evaluate("const e=[...document.querySelectorAll('.ezr-pdf-edit-box')].find(e=>e.dataset.fullText==='Second translated box');e.dispatchEvent(new KeyboardEvent('keydown',{key:' ',ctrlKey:true,bubbles:true}));document.getElementById('pdf-edit-original').click()");
  await complete(); await pause(150);
  check('翻译进行中标记后跳过后续片段，迟到译文不能覆盖原文',!calls.slice(during).includes('Second translated box') && await page.evaluate("window.__ezrPdfTranslation.state.originals.length===2 && ![...document.querySelectorAll('.ezr-pdf-text')].some(e=>/First|Second/.test(e.dataset.fullText))"));
  await loadFile(formulaPath);
  await edit();
  // Select all translated candidates through their keyboard-accessible hit boxes, including offscreen page two.
  await page.evaluate("(()=>{for(const e of document.querySelectorAll('.ezr-pdf-edit-box'))e.dispatchEvent(new KeyboardEvent('keydown',{key:' ',ctrlKey:true,bubbles:true}));document.getElementById('pdf-edit-original').click()})()");
  await page.evaluate("document.getElementById('pdf-page').value=2;document.getElementById('pdf-page').dispatchEvent(new Event('change'))");
  await until(()=>page.evaluate("!!document.querySelector('.page[data-page-number=\"2\"] .ezr-pdf-edit-box')"),'第二页选框');
  await selectText('Another page box'); await page.evaluate("document.getElementById('pdf-edit-original').click();document.getElementById('pdf-edit-done').click()");
  const allCount=calls.length; await start();
  check('全部原文时不发送请求，给出保留原文说明',calls.length===allCount && await control("return sh.querySelector('.ezr-full-status').textContent.includes('均已标记')"));
  await loadFile(formulaPath);
  check('重新打开文件清除原文标记',await page.evaluate('window.__ezrPdfTranslation.state.originals.length===0'));
}
