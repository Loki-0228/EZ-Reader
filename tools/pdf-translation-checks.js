/** Real extension/PDF.js acceptance with local PDF bytes and intercepted translation requests. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, CdpSession, waitForEndpoint } from './cdp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-artifacts', 'pdf-translation');
const port = Number(process.env.EZR_CDP_PORT || 9341);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label) => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await pause(80); }
  throw new Error('等待超时：' + label);
};
function fixturePdf() {
  const streams = [
    '0.9 0.94 1 rg 25 25 550 370 re f\n0 0 0 rg\nBT /F1 22 Tf 45 340 Td (First translated box) Tj ET\nBT /F1 18 Tf 45 240 Td (Second translated box) Tj ET\nBT /F1 18 Tf 330 240 Td (Third translated box) Tj ET',
    'BT /F1 20 Tf 45 340 Td (Another page box) Tj ET',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 420] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 420] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
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
  const calls = []; let failSecond = true;
  session.on('Fetch.requestPaused', async event => {
    const source = new URL(event.request.url).searchParams.get('q'); calls.push(source);
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
  const loadFile = async () => {
    const { root: dom } = await session.send('DOM.getDocument', {}, page.sessionId);
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: dom.nodeId, selector: '#pdf-file' }, page.sessionId);
    await session.send('DOM.setFileInputFiles', { nodeId, files: [pdfPath] }, page.sessionId);
    await until(() => page.evaluate("document.getElementById('pdf-total').textContent==='/ 2' && !!document.getElementById('ezr-root')"), '打开 PDF');
  };
  await loadFile();
  const control = code => page.evaluate(`(()=>{const sh=document.getElementById('ezr-root').shadowRoot;${code}})()`);
  await control("sh.querySelector('.ezr-btn-translation').click()").catch(async () => page.evaluate("globalThis.__ezr.send({type:'ezr:full-translation'})"));
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
  if (!process.argv.includes('--retry-only')) {
  const click = async (x, y, modifiers = 0) => {
    await session.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1, modifiers }, page.sessionId);
    await session.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1, modifiers }, page.sessionId);
  };
  const boxes = () => page.evaluate("[...document.querySelectorAll('.page[data-page-number=\"1\"] .ezr-pdf-text')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.box,size:Number(e.dataset.fontSize),left:r.left,top:r.top,right:r.right,bottom:r.bottom}})");
  const selected = () => page.evaluate("document.querySelectorAll('.ezr-pdf-text-selected').length");
  const inputSize = async value => page.evaluate(`(()=>{const input=document.getElementById('pdf-edit-font-size');input.value=${value};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('pdf-edit-apply').click()})()`);
  check('译文显示时可打开批量编辑', await page.evaluate("!document.getElementById('pdf-batch-edit').hidden && !document.getElementById('pdf-batch-edit').disabled"));
  await page.evaluate("document.getElementById('pdf-batch-edit').click()");
  check('未选择时禁止应用字号', await page.evaluate("document.getElementById('pdf-edit-apply').disabled"));
  let firstPage = await boxes(); const first = firstPage[0];
  await click(first.left + 8, first.top + 8);
  check('点击一个译文文本框可单选', await selected() === 1);
  await inputSize(10);
  await until(() => page.evaluate(`Number(document.querySelector('[data-box="${first.id}"]').dataset.fontSize)===10`), '应用单框字号');
  check('单框字号只改变选中的文本框', (await boxes()).slice(1).every((box, index) => box.size === firstPage[index + 1].size));
  firstPage = await boxes();
  await click(firstPage[1].left + 8, firstPage[1].top + 8, 2);
  check('Ctrl 点击可追加选择', await selected() === 2);
  await page.evaluate("document.getElementById('pdf-edit-clear').click()");
  const left = Math.min(...firstPage.map(box => box.left)) - 8, top = Math.min(...firstPage.map(box => box.top)) - 8;
  const right = Math.max(...firstPage.map(box => box.right)) + 8, bottom = Math.max(...firstPage.map(box => box.bottom)) + 8;
  await session.send('Input.dispatchMouseEvent', { type:'mousePressed', x:left, y:top, button:'left', clickCount:1 }, page.sessionId);
  await session.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:right, y:bottom, buttons:1 }, page.sessionId);
  await session.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:right, y:bottom, button:'left', clickCount:1 }, page.sessionId);
  check('拖动矩形选中多个译文文本框', await selected() === 3);
  await inputSize(12);
  await until(async () => (await boxes()).every(box => box.size === 12), '批量字号');
  check('批量应用保持精确字号，行高自动适应', await page.evaluate("[...document.querySelectorAll('.ezr-pdf-text-selected')].every(e=>parseFloat(getComputedStyle(e).lineHeight)>=12 && e.dataset.fullText===e.textContent.replaceAll('\u200b',''))"));
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
  check('显示原文时关闭批量编辑入口', await page.evaluate("document.getElementById('pdf-batch-edit').hidden || document.getElementById('pdf-batch-edit').disabled"));
  const requestsBeforeRestore = calls.length;
  await control("sh.querySelector('.ezr-full-start').click()");
  await until(async () => (await boxes()).length === 3 && (await boxes()).every(box => box.size === 12), '恢复译文');
  check('切回译文保留字号和成功缓存', calls.length === requestsBeforeRestore);
  await page.evaluate("window.__pdfExport=window.open('about:blank');window.__ezrPdfTranslation.exportPreview(window.__pdfExport)");
  check('导出沿用手工字号与完整译文', await page.evaluate("[...window.__pdfExport.document.querySelectorAll('.export-page:first-of-type .ezr-pdf-text')].length===3 && [...window.__pdfExport.document.querySelectorAll('.export-page:first-of-type .ezr-pdf-text')].every(e=>Number(e.dataset.fontSize)===12 && e.dataset.fullText===e.textContent.replaceAll('\u200b',''))"));
  await page.evaluate('window.__pdfExport.close()');
  // Simulate the source tab losing focus: rAF callbacks stop entirely while export renders.
  await page.evaluate("window.__ezrRaf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0");
  await page.evaluate("window.__pdfExport=window.open('about:blank');window.__exportDone=false;window.__ezrPdfTranslation.exportPreview(window.__pdfExport).then(()=>{window.__exportDone=true},e=>{window.__exportDone='失败：'+((e&&e.message)||e)});0");
  await until(() => page.evaluate('window.__exportDone!==false'), 'rAF 停摆时导出');
  check('源窗口失焦 rAF 停摆时导出仍能完成', await page.evaluate('window.__exportDone===true && window.__pdfExport.document.querySelectorAll(".export-page").length===2'));
  await page.evaluate("window.requestAnimationFrame=window.__ezrRaf;window.__pdfExport.close()");
  await page.evaluate("document.getElementById('pdf-batch-edit').click()");
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
  check('重新打开文件清除译文和编辑选择', await page.evaluate("window.__ezrPdfTranslation.state.translated===0 && document.getElementById('pdf-edit-controls').hidden"));
  }
  await writeFile(path.join(artifacts, 'browser-console.json'), JSON.stringify(page.console, null, 2));
  console.log(`PDF 浏览器检查通过 ${checks} 项`);
} catch (error) {
  if (page) console.error(JSON.stringify({ console: page.console, state: await page.evaluate("({href:location.href,title:document.title,status:document.getElementById('pdf-status')?.textContent,full:document.getElementById('ezr-root')?.shadowRoot?.querySelector('.ezr-full-status')?.textContent})").catch(() => null) }, null, 2));
  throw error;
} finally {
  if (session) { await session.send('Browser.close').catch(() => {}); session.close(); }
  browser.kill();
}
