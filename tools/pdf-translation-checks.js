/** Real extension/PDF.js acceptance with local PDF bytes and intercepted translation requests. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';
import { pdfOriginalChecks } from './pdf-original-checks.js';
import { pdfReaderChecks } from './pdf-reader-checks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-artifacts', 'pdf-translation');
const port = Number(process.env.EZR_CDP_PORT || 9341);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label) => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await pause(80); }
  throw new Error('等待超时：' + label);
};
function fixturePdf(formula = false, secondHeight = 420, secondWidth = 600) {
  const streams = [
    '0.9 0.94 1 rg 25 25 550 370 re f\n0 0 0 rg\nBT /F1 22 Tf 45 340 Td (First translated box) Tj ET\nBT /F1 18 Tf 45 240 Td (Second translated box) Tj ET\nBT /F1 18 Tf 330 240 Td (Third translated box) Tj ET',
    'BT /F1 20 Tf 45 340 Td (Another page box) Tj ET',
  ];
  if (formula) streams[0] += '\nBT /F1 20 Tf 45 120 Td (E = mc) Tj /F1 10 Tf 60 8 Td (2) Tj ET\nBT /F1 12 Tf 45 85 Td (123 + 456) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 420] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${secondWidth} ${secondHeight}] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`,
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return text + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

await mkdir(artifacts, { recursive: true });
const pdfPath = path.join(artifacts, 'boxes.pdf');
await writeFile(pdfPath, fixturePdf(), 'ascii');
const browser = spawn(process.env.EZR_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(artifacts, 'profile-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-features=Translate,MediaRouter,OptimizationHints',
  `--disable-extensions-except=${path.join(root, 'dist', 'extension')}`, `--load-extension=${path.join(root, 'dist', 'extension')}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });
let session, page; let checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('[PASS] ' + label); };
try {
  await waitForEndpoint(port);
  session = await CdpSession.connect({ port });
  let worker;
  await until(async () => {
    const { targetInfos } = await session.send('Target.getTargets');
    worker = targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension:') && target.url.endsWith('/background.js'));
    return worker;
  }, '扩展后台');
  const extensionOrigin = 'chrome-extension://' + new URL(worker.url).host;
  const { sessionId: workerSession } = await session.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  const calls = []; let failSecond = true, delayNext = 0;
  session.on('Fetch.requestPaused', async event => {
    const source = new URL(event.request.url).searchParams.get('q'); calls.push(source);
    const wait=delayNext; delayNext=0; if(wait)await pause(wait);
    const failed = failSecond && source.startsWith('Second');
    const data = { responseStatus: 200, responseData: { translatedText: '译文：' + source } };
    await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: failed ? 429 : 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') }, workerSession);
  }, workerSession);
  await session.send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.mymemory.translated.net/*' }] }, workerSession);
  page = await CdpPage.attach(session, { url: extensionOrigin + '/pages/document-reader.html' });
  await page.setViewport(1280, 960);
  await until(() => page.evaluate('!!globalThis.__ezrPdfTranslation'), 'PDF 页面');
  await page.evaluate("chrome.storage.local.set({'ezr:translation:config':{enabled:true,source:'en',target:'zh-CN',provider:'free',preload:false,wordCards:false}})");
  const loadFile = async (filePath = pdfPath) => {
    const { root: dom } = await session.send('DOM.getDocument', {}, page.sessionId);
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: dom.nodeId, selector: '#pdf-file' }, page.sessionId);
    await session.send('DOM.setFileInputFiles', { nodeId, files: [filePath] }, page.sessionId);
    await until(() => page.evaluate(`document.title===${JSON.stringify(path.basename(filePath))} && !document.getElementById('pdf-file').disabled && document.getElementById('pdf-total').textContent==='/ 2' && !!document.getElementById('ezr-root')`), '打开 PDF');
  };
  await loadFile();
  const mixedPath=path.join(artifacts,'mixed-size.pdf');
  await writeFile(mixedPath,fixturePdf(false,800,900),'ascii');
  await pdfReaderChecks({page,session,check,loadFile,mixedPath,pdfPath,artifacts});
  const control = code => page.evaluate(`(()=>{const sh=document.getElementById('ezr-root').shadowRoot;${code}})()`);
  await control("sh.querySelector('.ezr-btn-translation').click()").catch(async () => page.evaluate("globalThis.__ezr.send({type:'ezr:full-translation'})"));
  const toolMetrics = () => page.evaluate(`(()=>{const sh=document.getElementById('ezr-root').shadowRoot;return [sh.querySelector('.ezr-toolbar'),sh.querySelector('.ezr-full-bar'),document.getElementById('pdf-navigation')].map(e=>({font:parseFloat(getComputedStyle(e).fontSize),height:e.getBoundingClientRect().height}))})()`);
  const originalTools = await toolMetrics();
  check('PDF 编辑栏与阅读和翻译工具栏使用相同字号', originalTools.every(item=>item.font===13));
  const optionsPage = await CdpPage.attach(session,{url:extensionOrigin+'/pages/options.html'});
  await until(()=>optionsPage.evaluate("document.querySelector('[data-key=fontId]')?.options.length>0 && document.readyState==='complete'"),'字体缩放设置页');
  await pause(300);
  const setToolScale = value => optionsPage.evaluate(`(()=>{const input=document.querySelector('[data-key=toolFontScale]');input.value=${value};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await setToolScale(.75);
  await until(async()=>(await toolMetrics()).every(item=>item.font===9.75),'同步工具字号');
  check('缩小字体同时缩小三栏高度', (await toolMetrics()).every((item,i)=>item.height<originalTools[i].height));
  await page.screenshot({path:path.join(artifacts,'tools-75-percent.png')});
  await page.evaluate("chrome.storage.local.set({'ezr:settings:byOrigin':{[location.origin]:{toolFontScale:1.75}}}).then(()=>window.__ezr.send({type:'ezr:reload'}))");
  check('站点设置不能覆盖全局工具字体缩放', (await toolMetrics()).every(item=>item.font===9.75));
  await control("sh.querySelector('.ezr-btn-settings').click()");
  check('原网页模式设置中也可调整工具字体',await control("const input=sh.querySelector('[data-ezr-setting=toolFontScale]');return input && !input.disabled && !!input.getClientRects().length"));
  await pause(300); // Let the options page's own-write echo guard expire before another surface edits.
  await control("const input=sh.querySelector('[data-ezr-setting=toolFontScale]');input.value=1.25;input.dispatchEvent(new Event('input',{bubbles:true}));sh.querySelector('.ezr-settings-close').click()");
  await until(async()=>(await toolMetrics()).every(item=>item.font===16.25),'抽屉设置同步字号');
  await until(()=>optionsPage.evaluate("document.querySelector('[data-key=toolFontScale]').value==='1.25'"),'独立设置页同步');
  await optionsPage.evaluate("document.getElementById('set-tool-font-scale').scrollIntoView({block:'center'})");
  await optionsPage.screenshot({path:path.join(artifacts,'tool-font-settings.png')});
  await setToolScale(1);
  await until(async()=>(await toolMetrics()).every(item=>item.font===13),'恢复默认工具字号');
  await optionsPage.close();
  await control("sh.querySelector('.ezr-full-start').click()");
  await until(() => control("return sh.querySelector('.ezr-full-stop').hidden && /4/.test(sh.querySelector('.ezr-full-status').textContent)"), '首次翻译结束');
  check('单项失败后继续翻译其他 PDF 文本框', calls.length === 4 && calls.includes('Another page box'));
  check('直接显示重试失败项入口', await control("return !sh.querySelector('.ezr-full-retry').hidden && sh.querySelector('.ezr-full-retry').textContent.includes('1')"));
  await control("sh.querySelector('.ezr-full-retry').click()");
  await until(() => control("return sh.querySelector('.ezr-full-stop').hidden"), '重试仍失败');
  check('重试仍失败时结束本轮并保留失败项', calls.length === 5 && await control("return !sh.querySelector('.ezr-full-retry').hidden"));
  failSecond = false;
  await control("sh.querySelector('.ezr-full-retry').click()");
  await until(() => control("return sh.querySelector('.ezr-full-stop').hidden && sh.querySelector('.ezr-full-retry').hidden"), '失败项重试');
  check('仅重新请求失败文本框，成功项不重复请求', calls.length === 6 && calls.at(-1) === 'Second translated box');
  await until(() => page.evaluate("document.querySelectorAll('.page[data-page-number=\"1\"] .ezr-pdf-text').length===3"), '译文覆盖层');
  check('PDF 请求失败重试入口按页显示', await control("return sh.querySelector('.ezr-full-retry').textContent.startsWith('重试失败页')"));
  const beforeDisplayRetry = calls.length;
  await page.setViewport(1280,2200);
  await until(() => page.evaluate("document.querySelector('.page[data-page-number=\"2\"] canvas')"), '显示第二页');
  await page.evaluate(`(async()=>{
    window.__canvasGetContext=HTMLCanvasElement.prototype.getContext;
    window.__failOverlay=true;window.__overlayAttempts=0;window.__overlayCanvases=new WeakSet();
    HTMLCanvasElement.prototype.getContext=function(...args){
      if(this.width===1200&&this.height===840&&!window.__overlayCanvases.has(this)){
        window.__overlayCanvases.add(this);
        window.__overlayAttempts++;
        if(window.__stopNextOverlay){window.__stopNextOverlay=false;queueMicrotask(()=>document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-full-stop').click());}
        if(window.__failOverlay)throw new Error('模拟译文页面绘制失败');
      }
      return window.__canvasGetContext.apply(this,args);
    };
    const adapter=window.__ezrPdfTranslation,groups=await adapter.prepare();
    adapter.restore();adapter.apply(groups.map(group=>({id:group.id,text:'译文：'+group.source})));
  })()`);
  await until(() => page.evaluate('window.__ezrPdfTranslation.state.failedPages.length===2'), '两页绘制失败均记录');
  check('单页显示失败不会阻断后续页面，工具栏显示失败页码', await control("return sh.querySelector('.ezr-full-retry').textContent==='重试失败页（2）' && sh.querySelector('.ezr-full-page-status').textContent.includes('1、2')"));
  await page.setViewport(390,844);
  await page.screenshot({ path:path.join(artifacts,'retry-mobile.png') });
  check('窄屏失败说明不与翻译进度重叠', await control("const a=sh.querySelector('.ezr-full-status').getBoundingClientRect(),b=sh.querySelector('.ezr-full-page-status').getBoundingClientRect();return b.top>=a.bottom && b.right<=innerWidth"));
  await page.setViewport(1280,960);
  await page.screenshot({ path:path.join(artifacts,'retry-desktop.png') });
  await control("sh.querySelector('.ezr-full-retry').click();sh.querySelector('.ezr-full-retry').click()");
  await until(() => control("return sh.querySelector('.ezr-full-stop').hidden"), '显示失败重试结束');
  check('重复点击不会并发重试，持续失败仍保留两页', await page.evaluate('window.__overlayAttempts===4 && window.__ezrPdfTranslation.state.failedPages.length===2'));
  await page.evaluate('window.__failOverlay=false;window.__stopNextOverlay=true');
  await control("sh.querySelector('.ezr-full-retry').click()");
  await until(() => page.evaluate('!window.__ezrPdfTranslation.state.retrying'), '停止页面重试');
  check('停止重试后不处理后续页且迟到结果不清除失败记录', await page.evaluate('window.__overlayAttempts===5 && window.__ezrPdfTranslation.state.failedPages.length===2'));
  await control("sh.querySelector('.ezr-full-retry').click()");
  await until(() => control("return sh.querySelector('.ezr-full-stop').hidden && sh.querySelector('.ezr-full-retry').hidden"), '失败页恢复');
  check('显示失败重试包含视口外页面且不重复请求翻译', calls.length===beforeDisplayRetry && await page.evaluate('window.__overlayAttempts===7 && window.__ezrPdfTranslation.state.failedPages.length===0'));
  await page.evaluate('HTMLCanvasElement.prototype.getContext=window.__canvasGetContext');
  await page.evaluate("document.getElementById('pdf-fit').click();document.getElementById('pdf-container').scrollTop=0");
  await pause(250);
  if (!process.argv.includes('--retry-only')) {
  await session.send('Page.bringToFront',{},page.sessionId);
  await page.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:cards-save',card:{term:'First',translation:'First',sourceLanguage:'en',targetLanguage:'zh-CN'}})");
  await page.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{bubbleCards:true,enabled:false}})");
  await until(()=>control("return !!sh.querySelector('.ezr-bubble-dot[data-term=First]:not([hidden])')"),'PDF 词卡圆点');
  check('PDF 译文文本框可显示生词本黄点',await control("return sh.querySelector('.ezr-bubble-dot[data-term=First]').dataset.saved==='true'"));
  await control("sh.querySelector('.ezr-bubble-dot[data-term=First]').click()");
  check('PDF 词卡在文字附近打开且不请求翻译',calls.length===beforeDisplayRetry && await control("return !sh.querySelector('.ezr-bubble-card').hidden && sh.querySelector('.ezr-bubble-card').textContent.includes('First')"));
  await page.evaluate("document.getElementById('pdf-batch-edit').click()");
  await until(()=>control("return sh.querySelector('.ezr-bubbles').hidden"),'编辑期间隐藏词卡');
  await page.evaluate("document.getElementById('pdf-batch-edit').click()");
  await until(()=>control("return !sh.querySelector('.ezr-bubbles').hidden"),'编辑结束恢复词卡');
  check('PDF 词卡在批量编辑期间隐藏，退出后恢复',await control("return !!sh.querySelector('.ezr-bubble-dot[data-term=First]')"));
  await page.evaluate("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{bubbleCards:false,enabled:true}})");
  const click = async (x, y, modifiers = 0) => {
    await session.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1, modifiers }, page.sessionId);
    await session.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1, modifiers }, page.sessionId);
  };
  const boxes = () => page.evaluate("[...document.querySelectorAll('.page[data-page-number=\"1\"] .ezr-pdf-text')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.box,size:Number(e.dataset.fontSize),left:r.left,top:r.top,right:r.right,bottom:r.bottom}})");
  const selected = () => page.evaluate("document.querySelectorAll('.ezr-pdf-text-selected').length");
  const inputSize = async value => page.evaluate(`(()=>{const input=document.getElementById('pdf-edit-font-size');input.value=${value};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  check('译文显示时可打开批量编辑', await page.evaluate("!document.getElementById('pdf-batch-edit').hidden && !document.getElementById('pdf-batch-edit').disabled"));
  await page.evaluate("document.getElementById('pdf-batch-edit').click()");
  await until(()=>page.evaluate('window.__ezrPdfTranslation.state.editing'),'批量编辑准备完成'); await pause(120);
  check('未选择时禁用字号与对齐控件', await page.evaluate("['pdf-edit-font-size','pdf-edit-size-drag','pdf-edit-horizontal','pdf-edit-vertical'].every(id=>document.getElementById(id).disabled)"));
  let firstPage = await boxes(); const first = firstPage[0];
  await click(first.left + 8, first.top + 8);
  check('点击一个译文文本框可单选', await selected() === 1);
  await inputSize(10);
  check('输入字号无需应用即可同步刷新文字层', (await boxes())[0].size===10 && await page.evaluate("!document.getElementById('pdf-edit-apply')"));
  await until(() => page.evaluate(`Number(document.querySelector('.ezr-pdf-text[data-box="${first.id}"]').dataset.fontSize)===10`), '应用单框字号');
  check('单框字号只改变选中的文本框', (await boxes()).slice(1).every((box, index) => box.size === firstPage[index + 1].size));
  await page.evaluate("const input=document.getElementById('pdf-edit-horizontal');input.value='center';input.dispatchEvent(new Event('change',{bubbles:true}))");
  firstPage = await boxes();
  await click(firstPage[1].left + 8, firstPage[1].top + 8, 2);
  check('Ctrl 点击可追加选择', await selected() === 2);
  check('多选不同字号与对齐时显示混合状态',await page.evaluate("document.getElementById('pdf-edit-font-size').placeholder==='多种字号' && document.getElementById('pdf-edit-horizontal').value===''"));
  await page.evaluate("document.getElementById('pdf-edit-clear').click()");
  await pause(150); firstPage = await boxes(); // Finish the prior layout/scroll before starting a new pointer gesture.
  const left = Math.min(...firstPage.map(box => box.left)) - 8, top = Math.min(...firstPage.map(box => box.top)) - 8;
  const right = Math.max(...firstPage.map(box => box.right)) + 8, bottom = Math.max(...firstPage.map(box => box.bottom)) + 8;
  await session.send('Input.dispatchMouseEvent', { type:'mousePressed', x:left, y:top, button:'left', clickCount:1 }, page.sessionId);
  await session.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:right, y:bottom, buttons:1 }, page.sessionId);
  await session.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:right, y:bottom, button:'left', clickCount:1 }, page.sessionId);
  check('拖动矩形选中多个译文文本框', await selected() === 3);
  await inputSize(12);
  await until(async () => (await boxes()).every(box => box.size === 12), '批量字号');
  check('批量应用保持精确字号，行高自动适应', await page.evaluate("[...document.querySelectorAll('.ezr-pdf-text-selected')].every(e=>parseFloat(getComputedStyle(e).lineHeight)>=12 && e.dataset.fullText===e.textContent.replaceAll('\u200b',''))"));
  const align = (axis,value) => page.evaluate(`(()=>{const input=document.getElementById('pdf-edit-${axis}');input.value='${value}';input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await page.evaluate("window.__editCanvas=document.querySelector('.page[data-page-number=\"1\"] .ezr-pdf-surface canvas')");
  for (const horizontal of ['left','center','right']) {
    await align('horizontal',horizontal);
    check('实时水平对齐 '+horizontal,await page.evaluate(`[...document.querySelectorAll('.ezr-pdf-text-selected')].every(e=>getComputedStyle(e).textAlign==='${horizontal}')`));
  }
  for (const vertical of ['top','middle','bottom']) {
    await align('vertical',vertical);
    check('实时垂直对齐 '+vertical,await page.evaluate(`[...document.querySelectorAll('.ezr-pdf-text-selected')].every(e=>{const content=e.children.length*parseFloat(e.style.fontSize)*parseFloat(e.style.lineHeight);const expected=(parseFloat(e.style.height)-content)*${vertical==='top'?0:vertical==='middle'?.5:1};return Math.abs(parseFloat(e.firstElementChild.style.top)-expected)<.001})`));
  }
  check('字号和对齐预览复用原 PDF 画布',await page.evaluate("window.__editCanvas===document.querySelector('.page[data-page-number=\"1\"] .ezr-pdf-surface canvas')"));
  await pause(120);
  const handle = await page.evaluate("(()=>{const r=document.getElementById('pdf-edit-size-drag').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await session.send('Input.dispatchMouseEvent',{type:'mousePressed',...handle,button:'left',clickCount:1},page.sessionId);
  await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x,y:handle.y-20,buttons:1},page.sessionId);
  check('向上拖动在松开前实时增大全部选中文字', (await boxes()).every(box=>box.size===16));
  await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x,y:handle.y+10,buttons:1},page.sessionId);
  check('向下拖动实时缩小字号', (await boxes()).every(box=>box.size===10));
  await page.evaluate("document.getElementById('pdf-edit-size-drag').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1}))");
  await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x,y:handle.y-30,buttons:1},page.sessionId);
  check('拖动取消后移动鼠标不再改变字号', (await boxes()).every(box=>box.size===10));
  await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',...handle,button:'left',clickCount:1},page.sessionId);
  await inputSize(12);
  await page.evaluate("document.getElementById('pdf-edit-font-size').value='';document.getElementById('pdf-edit-font-size').dispatchEvent(new Event('input',{bubbles:true}))");
  check('临时清空字号输入不会写入零或丢失译文', (await boxes()).every(box=>box.size===12));
  await inputSize(12);
  check('编辑选框不会打开划词浮窗', await control("return [...sh.querySelectorAll('.ezr-translation')].every(e=>e.hidden)"));
  await page.screenshot({ path:path.join(artifacts,'desktop.png') });
  await inputSize(40);
  await until(async () => (await boxes()).every(box => box.size === 40), '较大字号');
  check('过大字号仍保留全部译文并显示提示', await page.evaluate("[...document.querySelectorAll('.ezr-pdf-text-selected')].every(e=>e.dataset.fullText===e.textContent.replaceAll('\u200b','')) && /超|溢/.test(document.getElementById('pdf-edit-controls').textContent+document.getElementById('pdf-status').textContent)"));
  await inputSize(12);
  await until(async () => (await boxes()).every(box => box.size === 12), '恢复测试字号');
  await page.setViewport(1000, 900); await page.evaluate("document.getElementById('pdf-fit').click()");
  await until(async () => (await boxes()).length === 3 && (await boxes()).every(box => box.size === 12), '缩放重绘');
  check('改变页面缩放后保持逻辑字号', (await boxes()).every(box => box.size === 12));
  await session.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape' }, page.sessionId);
  await session.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape' }, page.sessionId);
  check('Esc 退出编辑并清空选择', await page.evaluate("document.getElementById('pdf-edit-controls').hidden") && await selected() === 0);
  await control("sh.querySelector('.ezr-full-start').click()");
  check('显示原文时仍可打开批量编辑以标记公式', await page.evaluate("!document.getElementById('pdf-batch-edit').hidden && !document.getElementById('pdf-batch-edit').disabled"));
  const requestsBeforeRestore = calls.length;
  await control("sh.querySelector('.ezr-full-start').click()");
  await until(async () => (await boxes()).length === 3 && (await boxes()).every(box => box.size === 12), '恢复译文');
  check('切回译文保留字号和成功缓存', calls.length === requestsBeforeRestore);
  await page.evaluate("window.__pdfExport=window.open('about:blank');window.__ezrPdfTranslation.exportPreview(window.__pdfExport)");
  check('导出沿用手工字号与完整译文', await page.evaluate("[...window.__pdfExport.document.querySelectorAll('.export-page:first-of-type .ezr-pdf-text')].length===3 && [...window.__pdfExport.document.querySelectorAll('.export-page:first-of-type .ezr-pdf-text')].every(e=>Number(e.dataset.fontSize)===12 && e.dataset.fullText===e.textContent.replaceAll('\u200b',''))"));
  check('对齐设置在切换原文和导出后保留', await page.evaluate("[...window.__pdfExport.document.querySelectorAll('.export-page:first-of-type .ezr-pdf-text')].every(e=>e.dataset.horizontal==='right' && e.dataset.vertical==='bottom' && e.style.textAlign==='right')"));
  await page.evaluate('window.__pdfExport.close()');
  // Simulate the source tab losing focus: rAF callbacks stop entirely while export renders.
  await page.evaluate("window.__ezrRaf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0");
  await page.evaluate("window.__pdfExport=window.open('about:blank');window.__exportDone=false;window.__ezrPdfTranslation.exportPreview(window.__pdfExport).then(()=>{window.__exportDone=true},e=>{window.__exportDone='失败：'+((e&&e.message)||e)});0");
  await until(() => page.evaluate('window.__exportDone!==false'), 'rAF 停摆时导出');
  check('源窗口失焦 rAF 停摆时导出仍能完成', await page.evaluate('window.__exportDone===true && window.__pdfExport.document.querySelectorAll(".export-page").length===2'));
  await page.evaluate("window.requestAnimationFrame=window.__ezrRaf;window.__pdfExport.close()");
  await session.send('Page.bringToFront',{},page.sessionId);
  await page.evaluate("document.getElementById('pdf-batch-edit').click()");
  await pause(150);
  firstPage = await boxes(); await click(firstPage[0].left + 5, firstPage[0].top + 5);
  await page.evaluate("document.getElementById('pdf-edit-reset').click()");
  await until(async () => (await boxes())[0]?.size !== 12, '自动字号');
  check('恢复自动字号只影响所选文本框', (await boxes()).slice(1).every(box => box.size === 12));
  await control("sh.querySelector('.ezr-btn-original').click()");
  check('简洁阅读模式退出 PDF 批量编辑', await page.evaluate("document.getElementById('pdf-edit-controls').hidden"));
  await control("sh.querySelector('.ezr-btn-original').click()");
  await page.setViewport(390, 844); await page.evaluate("document.getElementById('pdf-fit').click();document.getElementById('pdf-batch-edit').click()");
  await pause(250);
  await page.screenshot({ path:path.join(artifacts,'mobile.png') });
  check('窄屏编辑工具栏可完整换行', await page.evaluate("document.getElementById('pdf-edit-controls').getBoundingClientRect().right<=innerWidth && document.documentElement.scrollWidth<=innerWidth"));
  await page.setViewport(1280, 960);
  await loadFile();
  await page.evaluate('window.__ezrPreparePdf()');
  check('重新打开文件清除译文、对齐和编辑选择', await page.evaluate("window.__ezrPdfTranslation.state.translated===0 && window.__ezrPdfTranslation.state.alignmentOverrides===0 && document.getElementById('pdf-edit-controls').hidden"));
  const formulaPath=path.join(artifacts,'formulas.pdf'),formulaBytes=fixturePdf(true);
  await writeFile(formulaPath,formulaBytes,'ascii');
  await pdfOriginalChecks({ page,session,control,calls,check,loadFile,formulaPath,formulaBytes,artifacts,setFailure:value=>{failSecond=value;},delayRequest:ms=>{delayNext=ms;} });
  }
  if (process.env.EZR_SAMPLE_PDF) {
    const sample = path.resolve(process.env.EZR_SAMPLE_PDF);
    await page.setViewport(1280,960);
    const { root: dom } = await session.send('DOM.getDocument', {}, page.sessionId);
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: dom.nodeId, selector: '#pdf-file' }, page.sessionId);
    await session.send('DOM.setFileInputFiles', { nodeId, files:[sample] }, page.sessionId);
    await until(() => page.evaluate(`document.title===${JSON.stringify(path.basename(sample))} && !document.getElementById('pdf-file').disabled`), '打开实际课件');
    const result = await page.evaluate(`(async()=>{
      const parsed=await window.__ezrPreparePdf(),adapter=window.__ezrPdfTranslation,groups=await adapter.prepare();
      adapter.apply(groups.map(group=>({id:group.id,text:'本地验证：'+group.source})));
      window.__samplePreview=window.open('about:blank');
      const exported=await adapter.exportPreview(window.__samplePreview);
      const count=window.__samplePreview.document.querySelectorAll('.ezr-pdf-text').length;
      window.__samplePreview.close();
      return {pages:parsed.pages.length,empty:parsed.pages.filter(p=>!p.boxes.length).length,boxes:groups.length,count,exported,failed:adapter.state.failedPages};
    })()`);
    check('实际课件的所有文本框均可定位、排版及导出', result.empty===0 && result.count===result.boxes && result.exported.pages===result.pages && result.failed.length===0);
    console.log('实际课件本地验证：'+JSON.stringify(result));
  }
  await writeFile(path.join(artifacts, 'browser-console.json'), JSON.stringify(page.console, null, 2));
  console.log(`PDF 浏览器检查通过 ${checks} 项`);
} catch (error) {
  if (page) await page.screenshot({ path:path.join(artifacts,'failure.png') }).catch(() => {});
  if (page) console.error(JSON.stringify({ console: page.console, state: await page.evaluate("({href:location.href,title:document.title,status:document.getElementById('pdf-status')?.textContent,full:document.getElementById('ezr-root')?.shadowRoot?.querySelector('.ezr-full-status')?.textContent})").catch(() => null) }, null, 2));
  throw error;
} finally {
  if (session) { await session.send('Browser.close').catch(() => {}); session.close(); }
  browser.kill();
}
