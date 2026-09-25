import path from 'node:path';
import { CdpPage } from './cdp.js';

/**
 * Free-form translation panel: opening it from the toolbar, translating typed
 * text, copying the result, dragging the window and the shared style prompt.
 *
 * API responses are intercepted inside the worker, so no account credits are used.
 */
export async function textTranslationChecks(page, iso, check, artifacts) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, label) => { for (let i = 0; i < 150; i++) { if (await predicate()) return; await pause(80); } throw new Error(label); };
  const session = page.session;
  const initialConfig = await iso("chrome.runtime.sendMessage({type:'ezr:translation:config'}).then(r=>r.config)");
  let options = null;

  await iso("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{source:'en',target:'zh-CN',provider:'free',stylePrompt:''}})");
  const opened = await iso('window.__ezr.open({})');
  check('输入文本翻译：阅读视图已打开', opened?.ok);
  await pause(250);
  await until(() => page.evaluate("!!document.getElementById('ezr-root')"), 'Toolbar did not mount');

  const extensionId = await iso('chrome.runtime.id');
  const { targetInfos } = await session.send('Target.getTargets');
  const worker = targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
  if (!worker) throw new Error('Translation service worker not found');
  const { sessionId } = await session.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });

  const calls = [];
  const off = session.on('Fetch.requestPaused', async event => {
    const request = event.request;
    const ds = request.url.includes('api.deepseek.com');
    const body = ds ? JSON.parse(request.postData) : null;
    calls.push({ url: request.url, body });
    const q = new URL(request.url).searchParams.get('q');
    const data = ds
      ? { choices: [{ finish_reason: 'stop', message: { content: body.response_format ? JSON.stringify({ topic: '测试', tone: '中性', terms: [] }) : `AI 译文：${JSON.parse(body.messages.at(-1).content).text}` } }] }
      : { responseStatus: 200, responseData: { translatedText: `免费译文：${q}` } };
    await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(data)).toString('base64') }, sessionId).catch(() => {});
  }, sessionId);
  await session.send('Fetch.enable', { patterns: ['https://api.mymemory.translated.net/*', 'https://api.deepseek.com/*'].map(urlPattern => ({ urlPattern })) }, sessionId);

  const sh = expression => iso(`(function(){ var sh=document.getElementById('ezr-root').shadowRoot; ${expression} })()`);
  const box = selector => sh(`var el=sh.querySelector(${JSON.stringify(selector)}); var r=el.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, left:r.left, top:r.top, width:r.width};`);
  const click = async selector => {
    const point = await box(selector);
    for (const type of ['mousePressed', 'mouseReleased']) await session.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }, page.sessionId);
    await pause(80);
  };
  const type = async (selector, value) => {
    await sh(`var el=sh.querySelector(${JSON.stringify(selector)}); el.focus(); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true}));`);
    await pause(60);
  };

  try {
    check('输入文本翻译浮窗默认隐藏', await sh("return sh.querySelector('.ezr-text-translation').hidden === true;"));
    await click('.ezr-btn-text-translation');
    check('工具栏“输入文本翻译”按钮打开浮窗', await sh("const p=sh.querySelector('.ezr-text-translation');return p.hidden===false && p.getBoundingClientRect().width>200;"));
    check('浮窗打开在视口内，不溢出窗口', await sh("const r=sh.querySelector('.ezr-text-translation').getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;"));
    check('空输入时翻译按钮不可用', await sh("return sh.querySelector('.ezr-text-run').disabled === true;"));

    await type('.ezr-text-input', 'Hello free form text');
    check('输入文字后翻译按钮可用', await sh("return sh.querySelector('.ezr-text-run').disabled === false;"));
    await click('.ezr-text-run');
    await until(() => sh("return sh.querySelector('.ezr-text-output').textContent.includes('免费译文');"), 'Free-form translation did not render');
    check('手输文字走翻译服务并显示在同一浮窗内', await sh("const out=sh.querySelector('.ezr-text-output').textContent;return out.includes('Hello free form text') && !sh.querySelector('.ezr-text-copy').disabled;"));
    check('免费翻译请求只带输入文字', calls.some(call => new URL(call.url).searchParams.get('q') === 'Hello free form text'));

    await session.send('Browser.grantPermissions', { origin: new URL(await page.evaluate('location.origin')).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
    await click('.ezr-text-copy');
    await pause(150);
    const clipboard = await page.evaluate('navigator.clipboard.readText().catch(function(){return "";})');
    check('“复制译文”把译文放进剪贴板', typeof clipboard === 'string' && clipboard.includes('免费译文'), `clipboard=${JSON.stringify(clipboard)}`);
    check('复制后给出状态反馈', await sh("return sh.querySelector('.ezr-text-status').textContent.includes('复制');"));

    const before = await box('.ezr-text-translation');
    const grabX = before.left + 40;
    const grabY = before.top + 26;
    // `buttons: 1` is what makes Chromium treat the move as a held-button drag.
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grabX, y: grabY, button: 'left', buttons: 1, clickCount: 1 }, page.sessionId);
    await pause(100);
    const grabbed = await sh("return sh.querySelector('.ezr-text-translation').classList.contains('is-dragging');");
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grabX - 60, y: grabY + 45, button: 'left', buttons: 1 }, page.sessionId);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grabX - 120, y: grabY + 90, button: 'left', buttons: 1 }, page.sessionId);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grabX - 120, y: grabY + 90, button: 'left', buttons: 0 }, page.sessionId);
    await pause(150);
    const after = await box('.ezr-text-translation');
    check('拖动浮窗标题栏可以移动窗口', Math.abs(after.left - (before.left - 120)) < 6 && Math.abs(after.top - (before.top + 90)) < 6,
      `grabbed=${grabbed} before=${Math.round(before.left)},${Math.round(before.top)} after=${Math.round(after.left)},${Math.round(after.top)}`);
    check('拖动后浮窗仍完整留在视口内', await sh("const r=sh.querySelector('.ezr-text-translation').getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;"));

    await type('.ezr-text-style', '口语化一点，保留专业术语原词');
    await pause(900);
    const saved = await iso("chrome.storage.local.get('ezr:translation:config').then(function(b){return b['ezr:translation:config'].stylePrompt;})");
    check('风格提示词写入共享翻译设置', saved === '口语化一点，保留专业术语原词', `stylePrompt=${JSON.stringify(saved)}`);

    await iso("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{provider:'deepseek'}})");
    await until(() => sh("return sh.querySelector('.ezr-text-provider').value==='deepseek';"), 'Provider did not switch to deepseek');
    // The key lives in the extension's own IndexedDB, so it can only be set from the options page.
    options = await CdpPage.attach(session, { url: `chrome-extension://${extensionId}/pages/options.html` });
    await until(() => options.evaluate("(() => { const s=document.getElementById('translation-save'), k=document.getElementById('translation-key-state'); return !!(s && k && !s.disabled && k.textContent.length>0); })()"), 'Translation settings did not load');
    await options.evaluate("document.getElementById('translation-key').value='sk-ezr-browser-test-only'; document.getElementById('translation-key').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('translation-save').click();");
    await until(() => options.evaluate("(() => { const s=document.getElementById('translation-save'), t=document.getElementById('translation-status'); return !!(s && t && !s.disabled && t.textContent.startsWith('翻译设置已保存')); })()"), 'Translation key was not saved');
    await options.close();
    options = null;
    await session.send('Page.bringToFront', {}, page.sessionId);
    await type('.ezr-text-input', 'Style check sentence');
    // Submit in the same event turn as the edit, before the 600 ms save timer.
    const duringRequest = await sh("const style=sh.querySelector('.ezr-text-style');style.value='使用书面表达，保留术语原词';style.dispatchEvent(new Event('input',{bubbles:true}));sh.querySelector('.ezr-text-run').click();return sh.querySelector('.ezr-text-clear').disabled && sh.querySelector('.ezr-text-style').disabled;");
    check('请求期间禁用清空和设置修改', duringRequest);
    await until(() => sh("return sh.querySelector('.ezr-text-output').textContent.includes('AI 译文');"), 'DeepSeek free-form translation did not render');
    const styled = calls.filter(call => call.body && !call.body.response_format).at(-1);
    const workerConfig = await iso("chrome.runtime.sendMessage({type:'ezr:translation:config'}).then(function(r){return r.config.stylePrompt;})");
    const stored = await iso("chrome.storage.local.get('ezr:translation:config').then(function(b){return b['ezr:translation:config'].stylePrompt;})");
    check('立即翻译使用刚输入的风格，并保留原有翻译规则', !!styled && styled.body.messages[0].content.includes('使用书面表达，保留术语原词')
      && styled.body.messages[0].content.includes('只负责将本次选中的文本翻译成指定目标语言'),
      `stored=${JSON.stringify(stored)} worker=${JSON.stringify(workerConfig)} styled=${!!styled}`);
    check('自由输入不触发文章语境分析，省下一次请求', !calls.some(call => call.body && call.body.response_format && call.url.includes('deepseek')));
    await page.screenshot({ path: path.join(artifacts, 'text-translation.png') });

    await iso("chrome.runtime.sendMessage({type:'ezr:translation:preferences',patch:{provider:'free'}})");
    await type('.ezr-text-input', 'x'.repeat(2001));
    check('超过 2000 字符时禁用翻译并给出提示', await sh("return sh.querySelector('.ezr-text-run').disabled===true && sh.querySelector('.ezr-text-status').textContent.includes('2000');"));

    await click('.ezr-text-clear');
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page.sessionId);
    check('Esc 关闭输入文本翻译浮窗并保留工具栏', await sh("return sh.querySelector('.ezr-text-translation').hidden===true && !!sh.querySelector('.ezr-toolbar');"));
  } finally {
    if (options) await options.close().catch(() => {});
    off();
    await session.send('Fetch.disable', {}, sessionId).catch(() => {});
    // This suite is the only one that stores a DeepSeek key, and other suites depend on
    // the keyless state, so remove it again on the way out.
    let cleanup = null;
    try {
      cleanup = await CdpPage.attach(session, { url: `chrome-extension://${extensionId}/pages/options.html` });
      await until(() => cleanup.evaluate("(() => { const b=document.getElementById('translation-remove-key'); return !!(b && !b.disabled); })()"), 'Key removal control unavailable');
      await cleanup.evaluate("document.getElementById('translation-remove-key').click()");
      await until(() => cleanup.evaluate("(() => { const s=document.getElementById('translation-key-state'); return !!s && s.textContent.includes('未配置'); })()"), 'DeepSeek key was not removed');
    } catch { /* best effort: the next run starts from a fresh profile anyway */ }
    finally { if (cleanup) await cleanup.close().catch(() => {}); }
    await iso('chrome.runtime.sendMessage({type:"ezr:translation:preferences",patch:' + JSON.stringify(initialConfig) + '})').catch(() => {});
    await session.send('Page.bringToFront', {}, page.sessionId).catch(() => {});
  }
}
