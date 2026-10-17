import { CdpPage } from './cdp.js';

/** Recover ordinary webpage toolbars through the real extension popup. */
export async function toolbarRecoveryChecks(page,iso,check) {
  const session=page.session,extensionId=await iso('chrome.runtime.id');
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await pause(80);}throw Error(label);};
  const sh=code=>iso(`(()=>{const sh=document.getElementById('ezr-root')?.shadowRoot;${code}})()`);
  let popup;
  const openPopup=async()=>{
    await popup?.close().catch(()=>{});
    await session.send('Page.bringToFront',{},page.sessionId);
    const target=await session.send('Target.createTarget',{url:`chrome-extension://${extensionId}/pages/popup.html`,background:true});
    popup=await CdpPage.attach(session,{targetId:target.targetId});
    await until(()=>popup.evaluate("!!document.getElementById('primary')&&!document.getElementById('primary').disabled"),'网页工具栏恢复入口置灰');
  };
  const click=()=>popup.evaluate("document.getElementById('primary').click()").catch(()=>{});
  try {
    await iso("chrome.runtime.sendMessage({type:'ezr:window-toolbar:set',enabled:false})");
    await openPopup();await click();
    await until(()=>sh("return !!sh&&!sh.querySelector('.ezr-toolbar').hidden"),'网页主栏未打开');
    await iso("window.__ezr.send({type:'ezr:full-translation'})");
    await sh("sh.querySelector('.ezr-btn-close').click();sh.querySelector('.ezr-full-close').click()");
    await openPopup();
    check('网页两栏独立关闭后恢复入口可点击',await popup.evaluate("document.getElementById('primary-label').textContent==='网页工具栏'"));
    await click();await until(()=>sh("return !sh.querySelector('.ezr-toolbar').hidden"),'两栏关闭后主栏未恢复');
    check('网页两栏关闭后可直接恢复主栏',true);
    await iso('window.__ezr.close()');
    await openPopup();
    check('网页会话结束后窗口旧开关不阻止恢复',await popup.evaluate("document.getElementById('primary-label').textContent==='网页工具栏'"));
    await click();await until(()=>sh("return !!sh&&!sh.querySelector('.ezr-toolbar').hidden"),'会话结束后工具栏未恢复');
    await openPopup();await click();
    await until(()=>sh("return sh.querySelector('.ezr-toolbar').hidden&&sh.querySelector('.ezr-full-bar').hidden"),'窗口关闭未隐藏两栏');
    await openPopup();
    check('从弹窗关闭窗口工具栏后仍保留可点击恢复入口',await popup.evaluate("document.getElementById('primary-label').textContent==='网页工具栏'"));
  } finally {
    await popup?.close().catch(()=>{});
    await iso("chrome.runtime.sendMessage({type:'ezr:window-toolbar:set',enabled:false})").catch(()=>{});
    await iso('window.__ezr.close()').catch(()=>{});
  }
}
