import path from 'node:path';
import { CdpPage } from './cdp.js';

/** Navigation and fit presets, before any translation requests are made. */
export async function pdfReaderChecks({ page, session, check, loadFile, mixedPath, pdfPath, artifacts }) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (test, label) => {
    for (let n = 0; n < 150; n++) { if (await test()) return; await pause(80); }
    throw Error(label + ': ' + JSON.stringify(await metrics()));
  };
  const control = code => page.evaluate(`(()=>{const sh=document.getElementById('ezr-root').shadowRoot;${code}})()`);
  const metrics = () => page.evaluate(`(()=>{
    const container=document.getElementById('pdf-container'),n=Number(document.getElementById('pdf-page').value),p=document.querySelector('.page[data-page-number="'+n+'"]'),r=p?.getBoundingClientRect(),c=container.getBoundingClientRect();
    const border=p?parseFloat(getComputedStyle(p).borderTopWidth):0;
    return {n,height:r?.height,width:r?.width,top:r?.top+border,bottom:r?.bottom-border,available:container.clientHeight,containerTop:c.top,containerBottom:c.top+container.clientHeight};
  })()`);
  const fitsHeight = async () => { const m=await metrics(); return m.height>0 && Math.abs(m.height-m.available)<=8 && m.top>=m.containerTop-2 && m.bottom<=m.containerBottom+2; };
  await control("sh.querySelector('.ezr-btn-translation').click()");
  await until(()=>page.evaluate("chrome.runtime.sendMessage({type:'ezr:window-toolbar:get'}).then(s=>s.translationVisible)"),'PDF 翻译栏状态未保存');
  await loadFile(mixedPath);
  check('更换 PDF 文件保留已打开的翻译工具栏',await control("return !sh.querySelector('.ezr-full-bar').hidden"));
  await page.evaluate("(()=>{const input=document.getElementById('pdf-page');input.value=2;input.dispatchEvent(new Event('change'))})()");
  await pause(350);
  check('适应宽度切到更宽的页面后不跳回前页',(await metrics()).n===2 && (await metrics()).width<=1280);
  await page.evaluate("(()=>{const input=document.getElementById('pdf-page');input.value=1;input.dispatchEvent(new Event('change'))})()");
  await page.evaluate("document.getElementById('pdf-fit-height').click()");
  await until(fitsHeight,'第一页适应高度');
  check('适应高度完整显示当前页并扣除两栏空间',await fitsHeight());
  await page.screenshot({path:path.join(artifacts,'fit-height-desktop.png')});
  await page.evaluate("(()=>{const input=document.getElementById('pdf-page');input.value=2;input.dispatchEvent(new Event('change'))})()");
  await until(async()=> (await metrics()).n===2 && await fitsHeight(),'不同页面尺寸适应高度');
  check('切到不同高度的页面后重新计算适应高度',await fitsHeight());
  await page.setViewport(1280,740);
  await until(fitsHeight,'窗口变矮后适应高度');
  check('窗口高度变化后仍适应高度',await fitsHeight());
  await control("sh.querySelector('.ezr-full-close').click()");
  await until(fitsHeight,'关闭翻译栏后适应高度');
  await until(()=>page.evaluate("chrome.runtime.sendMessage({type:'ezr:window-toolbar:get'}).then(s=>!s.translationVisible)"),'PDF 翻译栏关闭状态未保存');
  await loadFile(pdfPath);
  check('更换 PDF 后保持翻译栏关闭并保留高度模式',await control("return sh.querySelector('.ezr-full-bar').hidden") && await page.evaluate("document.getElementById('pdf-fit-height').getAttribute('aria-pressed')==='true'"));
  await control("sh.querySelector('.ezr-btn-translation').click()");
  await until(()=>page.evaluate("chrome.runtime.sendMessage({type:'ezr:window-toolbar:get'}).then(s=>s.translationVisible)"),'PDF 翻译栏重新打开未保存');
  const url=await page.evaluate('location.href');
  const next=await CdpPage.attach(session,{url});
  try {
    await until(()=>next.evaluate('!!globalThis.__ezrPdfTranslation'),'新 PDF 阅读页加载');
    await next.evaluate("globalThis.__ezr.send({type:'ezr:toolbar-open'})");
    check('新 PDF 阅读标签页继承翻译栏显示状态',await next.evaluate("!document.getElementById('ezr-root').shadowRoot.querySelector('.ezr-full-bar').hidden"));
  } finally { await next.close(); await session.send('Page.bringToFront',{},page.sessionId); }
  await page.goto(url);
  await until(()=>page.evaluate('!!globalThis.__ezrPdfTranslation'),'刷新 PDF 阅读页');
  await loadFile(pdfPath);
  check('刷新 PDF 阅读页后翻译栏仍显示且不自动翻译',await control("return !sh.querySelector('.ezr-full-bar').hidden && sh.querySelector('.ezr-full-start').textContent==='全文翻译' && sh.querySelector('.ezr-full-stop').hidden"));
  await page.setViewport(390,844);
  await page.evaluate("document.getElementById('pdf-fit-height').click()");
  await until(fitsHeight,'窄屏适应高度');
  check('窄屏高度模式允许 PDF 横向滚动，控制栏不溢出',await page.evaluate("document.documentElement.scrollWidth<=innerWidth && document.getElementById('pdf-container').scrollWidth>document.getElementById('pdf-container').clientWidth"));
  await page.screenshot({path:path.join(artifacts,'fit-height-mobile.png')});
  await page.evaluate("document.getElementById('pdf-fit').click()");
  await until(async()=> (await metrics()).width<=390,'切回适应宽度');
  check('可切回适应宽度且按钮状态互斥',await page.evaluate("document.getElementById('pdf-fit').getAttribute('aria-pressed')==='true' && document.getElementById('pdf-fit-height').getAttribute('aria-pressed')==='false'"));
  await page.setViewport(1280,960);
  await until(async()=> (await metrics()).width>1100,'恢复桌面宽度');
}
