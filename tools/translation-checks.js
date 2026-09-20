import path from 'node:path';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { CdpPage } from './cdp.js';

/** Real extension/UI pipeline with API responses intercepted in the worker, no account credits used. */
export async function translationChecks(page, iso, check, artifacts) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, label) => { for (let i = 0; i < 150; i++) { if (await predicate()) return; await pause(80); } throw new Error(label); };
  const original = await iso('document.documentElement.outerHTML');
  const opened = await iso('window.__ezr.open({})');
  check('翻译示例阅读视图可打开', opened?.ok);
  await pause(250);
  const extensionId = await iso('chrome.runtime.id');
  const session = page.session;
  const { targetInfos } = await session.send('Target.getTargets');
  const worker = targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
  if (!worker) throw new Error('Translation service worker not found');
  const { sessionId } = await session.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  const calls = [];
  let failNext = false, delayNext = false, dictionaryDown = false, allDictionariesDown = false;
  const off = session.on('Fetch.requestPaused', async event => {
    const request = event.request;
    const ds = request.url.includes('api.deepseek.com');
    const dictionary = request.url.includes('dictionaryapi.dev');
    const wiki = request.url.includes('en.wiktionary.org');
    const body = ds ? JSON.parse(request.postData) : null;
    calls.push({ url: request.url, body, authorized: request.headers.Authorization === 'Bearer sk-ezr-browser-test-only' });
    const code = failNext ? 429 : ((dictionaryDown && dictionary) || (allDictionariesDown && (dictionary || wiki))) ? 503 : 200;
    failNext = false;
    if (delayNext) { delayNext = false; await pause(400); }
    const q = new URL(request.url).searchParams.get('q');
    const data = dictionary ? [{ phonetic: '/bæŋk/', license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
      sourceUrls: ['https://en.wiktionary.org/wiki/bank'], meanings: [{ partOfSpeech: 'noun', definitions: [
        { definition: 'Land alongside a river.' }, { definition: 'A financial institution that manages deposits and loans.', example: 'The bank approved the loan.' },
      ] }] }]
      : wiki ? { en: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'A <a>financial</a> institution.', examples: ['The <b>bank</b> approved the loan.'] }] }] }
      : ds ? { choices: [{ finish_reason: 'stop', message: { content: body.messages[0].content.includes('挑选值得学习的英文生词')
      ? JSON.stringify({ words: [{ term: 'bank', translation: '银行', meaning: '存钱和借钱的机构。', usage: 'bank account：银行账户', example: 'I went to the bank.', exampleTranslation: '我去了银行。' },
        { term: 'financial', translation: '金融的', meaning: '与资金管理有关。', usage: 'financial services：金融服务' },
        { term: 'erosion', translation: '侵蚀', meaning: '水或风让土壤逐渐流失。' }] })
      : body.messages[0].content.includes('词语学习卡')
      ? JSON.stringify({ phonetic: '/bæŋk/', partOfSpeech: '名词', meaning: '存钱、借钱和办理金融业务的机构。', usage: '常见搭配：open a bank account（开户）。', example: 'I opened a bank account.', exampleTranslation: '我开了一个银行账户。' })
      : body.response_format
      ? JSON.stringify({ topic: '银行与河岸', tone: '说明文', terms: [{ source: 'bank', target: '银行或河岸，按相邻段落判断' }] })
      : JSON.parse(body.messages.at(-1).content).text === 'bank' ? '银行' : '这是一段结合当前语境生成的译文。' } }] }
      : { responseStatus: 200, responseData: { translatedText: q === 'bank' ? '银行'
        : q?.startsWith('A financial') ? '管理存款和贷款的金融机构。'
        : q === 'The bank approved the loan.' ? '银行批准了这笔贷款。' : '银行管理存款。<img src=x onerror=alert(1)>' } };
    await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: code,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') }, sessionId).catch(() => {});
  }, sessionId);
  await session.send('Fetch.enable', { patterns: ['https://api.mymemory.translated.net/*', 'https://api.deepseek.com/*',
    'https://api.dictionaryapi.dev/*', 'https://en.wiktionary.org/api/*'].map(urlPattern => ({ urlPattern })) }, sessionId);
  const evaluate = expression => iso(`(function(){ var sh=document.getElementById('ezr-root').shadowRoot; ${expression} })()`);
  const click = async selector => {
    const point = await evaluate(`var el=sh.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); var r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
    for (const type of ['mousePressed', 'mouseReleased']) await session.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }, page.sessionId);
    await pause(80);
  };
  const choose = async (index = 0, length = 55, start = 0) => {
    await evaluate(`var p=sh.querySelectorAll('.ezr-para')[${index}]; p.scrollIntoView({block:'center'});`);
    await pause(100);
    await evaluate(`var p=sh.querySelectorAll('.ezr-para')[${index}], range=document.createRange();
      p.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      range.setStart(p.firstChild,${start}); range.setEnd(p.firstChild,Math.min(${start + length},p.firstChild.length));
      var selection=sh.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      p.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));`);
    await pause(230);
  };
  const result = () => evaluate("return sh.querySelector('.ezr-translation-result').textContent;");
  const waitResult = async () => {
    for (let i = 0; i < 80; i++) {
      const ready = await evaluate("return !sh.querySelector('.ezr-translate-free').disabled;");
      if (ready) return result();
      await pause(80);
    }
    throw new Error('Translation result timeout');
  };
  const chooseWord = async word => {
    const start = await evaluate(`return sh.querySelector('.ezr-para').firstChild.textContent.indexOf(${JSON.stringify(word)});`);
    if (start < 0) throw new Error(`Missing fixture word ${word}`);
    await choose(0, word.length, start);
  };
  const waitCard = async () => {
    await waitResult();
    for (let i = 0; i < 80; i++) {
      if (await evaluate("return !sh.querySelector('.ezr-word-actions').hidden && !sh.querySelector('.ezr-word-export').disabled;")) return;
      await pause(80);
    }
    throw new Error('Word card timeout');
  };
  const waitLearning = async () => {
    await waitResult();
    for (let i = 0; i < 100; i++) {
      if (await evaluate("return !/正在/.test(sh.querySelector('.ezr-word-knowledge').textContent);")) return;
      await pause(80);
    }
    throw new Error('Learning timeout');
  };
  const analyses = () => calls.filter(c=>c.body?.messages[0].content.includes('语境分析器')).length;
  try {
    const listState = await evaluate(`var art=sh.querySelector('.ezr-article'); return {
      wrapper:[...art.querySelectorAll('.ezr-para')].some(p=>p.textContent.startsWith('Paragraph wrapper')),
      split:[...art.querySelectorAll('.ezr-para')].filter(p=>/^(First|Second) separated paragraph/.test(p.textContent)).map(p=>p.textContent),
      bullets:art.querySelectorAll('ul > li').length, ordered:[...art.querySelectorAll('ol > li')].map(li=>li.getAttribute('value'))
    };`);
    check('普通段落和无标记布局不添加小点', listState.wrapper && listState.split.length === 2 && !listState.split[1].includes('First'));
    check('真正分点保留符号且点内换行和段落不增加小点', listState.bullets === 3);
    check('有序列表保留原编号', JSON.stringify(listState.ordered) === '["3","7"]');
    const drag = await evaluate(`var text=sh.querySelector('.ezr-para').firstChild, r=document.createRange();
      r.setStart(text,0);r.setEnd(text,8);var box=r.getBoundingClientRect();return {x:box.left+1,y:box.top+box.height/2,end:box.right-1};`);
    await session.send('Input.dispatchMouseEvent', { type:'mousePressed', x:drag.x, y:drag.y, button:'left', clickCount:1 }, page.sessionId);
    await session.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:drag.end, y:drag.y, button:'left', buttons:1 }, page.sessionId);
    await session.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:drag.end, y:drag.y, button:'left', clickCount:1 }, page.sessionId);
    await pause(250);
    check('真实鼠标拖选文字可触发划词入口', await evaluate("return !sh.querySelector('.ezr-translation').hidden && sh.querySelector('.ezr-translation-source').textContent.length > 0;"));
    await choose();
    check('划词显示翻译浮层但尚未联网', calls.length === 0 && await evaluate("return !sh.querySelector('.ezr-translation').hidden;"));
    await click('.ezr-translate-free');
    const freeText = await waitResult();
    check('免费划词翻译通过后台返回并安全显示纯文本', freeText.includes('银行管理存款') && await evaluate("return sh.querySelector('.ezr-translation-result').children.length === 0;"));
    check('免费请求只包含选文，不含整篇文章', calls.length === 1 && !calls[0].url.includes('river'));
    await click('.ezr-translate-deepseek');
    check('未配置密钥时给出设置提示而不发请求', /API Key/.test(await waitResult()) && calls.length === 1);
    const options = await CdpPage.attach(session, { url: `chrome-extension://${extensionId}/pages/options.html` });
    await until(()=>options.evaluate("!document.getElementById('translation-save').disabled && document.getElementById('translation-key-state').textContent.length>0"),'Translation settings did not load');
    await options.evaluate(`document.getElementById('translation-key').value='sk-ezr-browser-test-only'; document.getElementById('translation-key').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('translation-save').click();`);
    await until(()=>options.evaluate("!document.getElementById('translation-save').disabled && document.getElementById('translation-status').textContent.startsWith('翻译设置已保存')"),'Translation key was not saved');
    check('设置页保存密钥后清空输入框', await options.evaluate(`document.getElementById('translation-key').value === '' && document.getElementById('translation-key-state').textContent.includes('已配置')`));
    const publicConfig = await iso(`chrome.runtime.sendMessage({type:'ezr:translation:config'})`);
    check('内容脚本收到的配置不包含密钥', publicConfig.hasKey && !JSON.stringify(publicConfig).includes('sk-ezr'));
    check('共享扩展存储与变更事件不携带密钥', !JSON.stringify(await iso('chrome.storage.local.get(null)')).includes('sk-ezr-browser-test-only'));
    const rejected = await iso(`chrome.runtime.sendMessage({type:'ezr:translation:save',apiKey:'should-not-save',config:{}})`);
    check('内容脚本不能修改 API 密钥', rejected.ok === false);
    await session.send('Page.bringToFront', {}, page.sessionId);
    await choose();
    await click('.ezr-translate-deepseek');
    await waitLearning();
    check('DeepSeek 首次先分析语境再翻译', (await result()).includes('当前语境') && analyses() === 1 && calls.filter(c=>c.body).length === 3);
    await choose(1);
    await click('.ezr-translate-deepseek');
    await waitLearning();
    check('同一阅读视图的下一次划词复用语境', analyses() === 1 && calls.filter(c=>c.body).length === 5);
    await page.screenshot({ path: path.join(artifacts, 'translation-deepseek.png') });
    failNext = true;
    await choose(1, 70);
    await click('.ezr-translate-free');
    check('接口限流显示可操作错误并允许重试', /额度|请求过多/.test(await waitResult()));
    delayNext = true;
    await click('.ezr-translate-free');
    await choose(0, 30);
    await pause(500);
    check('旧请求返回不会覆盖新选区', (await result()) === '' && await evaluate("return sh.querySelector('.ezr-translation-source').textContent.startsWith('The bank');"));
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page.sessionId);
    check('Esc 优先关闭翻译浮层，保留阅读器', await evaluate("return sh.querySelector('.ezr-translation').hidden;"));
    await page.evaluate(`history.pushState({}, '', '?view=changed')`);
    await choose(1, 45);
    await click('.ezr-translate-deepseek');
    await waitLearning();
    check('单页应用地址改变后重新分析，丢弃旧语境', analyses() === 2);
    await chooseWord('bank');
    await click('.ezr-translate-free'); await waitCard();
    check('词典单词卡显示音标、词性、当前释义和词典例句', await evaluate(`return sh.querySelector('.is-word-card') &&
      sh.querySelector('.ezr-word-meta').textContent.includes('/bæŋk/ · 名词') && sh.querySelector('.ezr-word-meaning').textContent.includes('金融机构')
      && sh.querySelector('.ezr-word-example').textContent.includes('The bank approved the loan.') && !!sh.querySelector('.ezr-word-credit a');`));
    await page.screenshot({ path: path.join(artifacts, 'word-card-dictionary.png') });
    await click('.ezr-word-save');
    const wordbook = async () => (await options.evaluate(`chrome.runtime.sendMessage({type:'ezr:translation:cards-list'})`)).cards;
    const savedCards = await wordbook();
    check('词语保存到生词本并保留原句和网页来源', savedCards.length === 1 && savedCards[0].term === 'bank' && savedCards[0].sourceSentence.includes('financial') && savedCards[0].pageUrl.includes('view=changed'), JSON.stringify(savedCards.map(({term, sourceSentence, pageUrl}) => ({term, sourceSentence, pageUrl}))));
    check('普通网页内容脚本不能读取整个生词本', (await iso(`chrome.runtime.sendMessage({type:'ezr:translation:cards-list'})`)).ok === false);
    let downloadDir = await mkdtemp(path.join(artifacts, 'word-cards-'));
    await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    const downloaded = async filename => {
      for (let i = 0; i < 60; i++) {
        if ((await readdir(downloadDir)).includes(filename)) return readFile(path.join(downloadDir, filename), 'utf8');
        await pause(100);
      }
      throw new Error(`Download missing: ${filename}`);
    };
    await click('.ezr-word-export');
    const singleExport = await downloaded('ez-reader-anki.txt');
    check('单卡实际下载为 Anki 两列格式并包含词典来源', singleExport.startsWith('#separator:Tab\n#html:true\n') && singleExport.includes('bank\t<b>银行</b>') && singleExport.includes('CC BY-SA'));
    const analysesBefore = calls.filter(c=>c.body?.messages[0].content.includes('语境分析器')).length;
    await click('.ezr-translate-deepseek'); await waitCard();
    check('AI 卡片复用语境并提供简洁用法和例句', await evaluate(`return sh.querySelector('.ezr-word-usage').textContent.includes('open a bank account')
      && sh.querySelector('.ezr-word-credit').textContent.includes('AI 生成');`) && calls.filter(c=>c.body?.messages[0].content.includes('语境分析器')).length === analysesBefore);
    await page.screenshot({ path: path.join(artifacts, 'word-card-ai.png') });
    await click('.ezr-word-save');
    check('同词从词典切换 AI 后保存会更新卡片而不重复', (await wordbook()).length === 1 && (await wordbook())[0].provider === 'ai');
    check('浮层选中的服务同步到已打开的设置页', await options.evaluate("document.getElementById('translation-provider').value === 'deepseek'"));
    dictionaryDown = true;
    await chooseWord('deposits'); await click('.ezr-translate-free'); await waitCard();
    check('词典接口失败时切换维基词典且去除远端 HTML', await evaluate(`return sh.querySelector('.ezr-word-meaning').textContent.includes('金融机构')
      && sh.querySelector('.ezr-word-credit a').href.includes('wiktionary') && !sh.querySelector('.ezr-word-knowledge a');`));
    await click('.ezr-word-save');
    check('设置页生词本实时显示已保存卡片', await options.evaluate(`document.getElementById('wordbook-count').textContent === '2 张' && document.querySelectorAll('.wordbook-row').length === 2`));
    downloadDir = await mkdtemp(path.join(artifacts, 'wordbook-export-'));
    await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await options.evaluate(`document.getElementById('wordbook-export').click()`);
    const batchExport = await downloaded('ez-reader-anki.txt');
    check('批量 Anki 导出包含全部卡片且转义服务端 HTML', batchExport.trim().split('\n').filter(line=>!line.startsWith('#')).length === 2 && !batchExport.includes('<img') && batchExport.includes('&lt;img'));
    await options.evaluate(`document.getElementById('wordbook-tsv').click()`);
    const tsv = await downloaded('ez-reader-words.tsv');
    check('通用 TSV 可复制导入其他记忆软件', tsv.trim().split('\n').length === 2 && tsv.trim().split('\n').every(row=>row.split('\t').length === 2));
    await options.evaluate(`var search=document.getElementById('wordbook-search');search.value='bank';search.dispatchEvent(new Event('input'));`);
    check('生词本可按词语筛选并移除单张卡片', await options.evaluate(`document.querySelectorAll('.wordbook-row').length === 1`));
    await options.evaluate(`document.querySelector('.wordbook-row button').click()`); await pause(200);
    check('移除卡片写入持久生词本', (await wordbook()).length === 1);
    await options.evaluate(`var search=document.getElementById('wordbook-search');search.value='';search.dispatchEvent(new Event('input'));`);
    await session.send('Page.bringToFront', {}, page.sessionId);
    allDictionariesDown = true;
    await chooseWord('manages'); await click('.ezr-translate-free'); await waitCard();
    check('词典均不可用时仍显示译文并允许保存及重试扩展', await evaluate(`return sh.querySelector('.ezr-translation-result').textContent.length > 0
      && !sh.querySelector('.ezr-word-save').disabled && !sh.querySelector('.ezr-word-retry').hidden;`));
    dictionaryDown = allDictionariesDown = false;
    await click('.ezr-word-retry'); await waitCard();
    check('失败的词语扩展可独立重试成功', await evaluate("return sh.querySelector('.ezr-word-retry').hidden && !!sh.querySelector('.ezr-word-meaning');"));
    const setPrefs = async patch => {
      await options.evaluate(`(async function(){
        var map={provider:'translation-provider',preload:'translation-preload',explanations:'translation-explanations',wordCards:'translation-word-cards',autoSave:'translation-auto-save',level:'translation-level'};
        for(var [key,value] of Object.entries(${JSON.stringify(patch)})){var el=document.getElementById(map[key]);if(typeof value==='boolean')el.checked=value;else el.value=value;}
        document.getElementById('translation-save').click();
      })()`);
      await pause(300);
    };
    const autoResult = async () => { await pause(550); await waitResult(); await waitLearning(); };
    await setPrefs({ provider:'free', preload:true, explanations:false, wordCards:false, autoSave:false, level:'B1' });
    let beforeCalls = calls.length, beforeWords = (await wordbook()).length;
    await chooseWord('customers'); await autoResult();
    check('开启预加载后无需点击，只调用选定的免费翻译', calls.length === beforeCalls + 1 && calls.at(-1).url.includes('mymemory') && (await result()).length > 0);
    check('讲解与卡片均关闭时只显示译文且不保存生词', await evaluate("return !sh.querySelector('.ezr-word-knowledge').textContent && sh.querySelector('.ezr-word-actions').hidden;") && (await wordbook()).length === beforeWords);
    beforeCalls = calls.length;
    await click('.ezr-pref-wordCards'); await pause(250); await waitCard();
    check('单词可独立生成基础卡片，无需词典或 AI 讲解请求', calls.length === beforeCalls && await evaluate("return !sh.querySelector('.ezr-word-actions').hidden && !sh.querySelector('.ezr-word-knowledge').textContent;"));
    check('生成卡片不等于保存，未点击时生词本保持不变', (await wordbook()).length === beforeWords);
    await click('.ezr-word-save');
    check('基础卡片可在用户点击后单独加入生词本', (await wordbook()).some(card=>card.term === 'customers'));
    await setPrefs({ provider:'free', preload:true, explanations:true, wordCards:false, autoSave:false });
    beforeCalls = calls.length; beforeWords = (await wordbook()).length;
    await chooseWord('loans'); await autoResult();
    check('可只生成词典讲解，不生成可导出卡片', calls.slice(beforeCalls).some(call=>call.url.includes('dictionaryapi'))
      && await evaluate("return !!sh.querySelector('.ezr-word-meaning') && sh.querySelector('.ezr-word-actions').hidden;") && (await wordbook()).length === beforeWords);
    await setPrefs({ provider:'deepseek', preload:true, explanations:false, wordCards:false });
    beforeCalls = calls.length;
    await chooseWord('businesses'); await autoResult();
    check('选择 DeepSeek 预加载时不会额外请求免费翻译或词典', calls.length > beforeCalls && calls.slice(beforeCalls).every(call=>call.url.includes('deepseek')));
    await setPrefs({ preload:false });
    beforeCalls = calls.length;
    await chooseWord('local'); await pause(700);
    check('取消预加载勾选后恢复点击才翻译', calls.length === beforeCalls && (await result()) === '');
    await setPrefs({ preload:true });
    beforeCalls = calls.length;
    await evaluate(`var p=sh.querySelector('.ezr-para'), start=p.firstChild.textContent.indexOf('information'), range=document.createRange();
      p.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); range.setStart(p.firstChild,start);range.setEnd(p.firstChild,start+11);
      var sel=sh.getSelection();sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new Event('selectionchange'));`);
    await pause(650);
    check('拖选尚未松开鼠标时不会预加载零碎选区', calls.length === beforeCalls);
    await evaluate("sh.querySelector('.ezr-para').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));");
    await pause(100);
    await session.send('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 }, page.sessionId);
    await pause(600);
    check('预加载等待期间关闭浮层会取消请求', calls.length === beforeCalls);
    await chooseWord('interest'); await chooseWord('rates'); await autoResult();
    const loadedTerms = calls.slice(beforeCalls).filter(call=>call.body && !call.body.response_format).map(call=>JSON.parse(call.body.messages.at(-1).content).text);
    check('快速换选区只预加载最后稳定的词语', loadedTerms.length === 1 && loadedTerms[0] === 'rates');
    await setPrefs({ provider:'deepseek', preload:false, explanations:true, wordCards:false, autoSave:false, level:'A2' });
    beforeWords = (await wordbook()).length;
    await choose(0,180); await click('.ezr-translate-deepseek'); await waitLearning();
    let vocabularyCalls = () => calls.filter(call=>call.body?.messages[0].content.includes('挑选值得学习的英文生词'));
    check('长段落按所选英语水平生成讲解，且只使用选文中的词', JSON.parse(vocabularyCalls().at(-1).body.messages[1].content).learnerLevel === 'A2'
      && await evaluate("return sh.querySelectorAll('.ezr-vocabulary-word').length === 2 && sh.querySelector('.ezr-word-actions').hidden;") && (await wordbook()).length === beforeWords);
    const analysisCount = analyses();
    await evaluate("var level=sh.querySelector('.ezr-study-level');level.value='C1';level.dispatchEvent(new Event('change'));");
    await pause(300); await waitLearning();
    check('切换学习水平重新挑词并复用已有文章语境', JSON.parse(vocabularyCalls().at(-1).body.messages[1].content).learnerLevel === 'C1' && analyses() === analysisCount);
    await click('.ezr-pref-wordCards'); await pause(200); await waitCard();
    check('长文讲解可转换为卡片，生成仍不自动收藏', await evaluate("return !sh.querySelector('.ezr-word-actions').hidden;") && (await wordbook()).length === beforeWords);
    await click('.ezr-study-article'); await waitLearning();
    check('本篇生词可分析整篇节选，不要求选中全文', JSON.parse(vocabularyCalls().at(-1).body.messages[1].content).text.length > 180
      && await evaluate("return sh.querySelectorAll('.ezr-vocabulary-word').length === 3 && sh.querySelector('.ezr-word-credit').textContent.includes('节选');"));
    await evaluate("sh.querySelector('.ezr-vocabulary-word').open=true; sh.querySelector('.ezr-translation').scrollTop=0;");
    await pause(80);
    check('展开长文词语讲解后浮层仍完整位于窗口内', await evaluate("var r=sh.querySelector('.ezr-translation').getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight;"));
    await page.screenshot({ path:path.join(artifacts,'translation-vocabulary.png') });
    await click('.ezr-pref-explanations'); await pause(250); await waitCard();
    check('长文也可只生成词语与译文卡片，不生成讲解', JSON.parse(vocabularyCalls().at(-1).body.messages[1].content).includeExplanation === false
      && await evaluate("return !sh.querySelector('.ezr-word-meaning') && !sh.querySelector('.ezr-word-actions').hidden;") && (await wordbook()).length === beforeWords);
    check('修改讲解开关后仍保留本篇生词范围', JSON.parse(vocabularyCalls().at(-1).body.messages[1].content).text.length > 180
      && await evaluate("return sh.querySelectorAll('.ezr-vocabulary-word').length === 3;"));
    await setPrefs({ provider:'deepseek',preload:true,explanations:false,wordCards:true,autoSave:true });
    await chooseWord('savings'); await autoResult(); await pause(100);
    check('只有另外勾选自动加入，生成的卡片才自动保存', (await wordbook()).some(card=>card.term === 'savings') && await evaluate("return sh.querySelector('.ezr-word-save').textContent === '已自动加入';"));
    beforeWords = (await wordbook()).length;
    await setPrefs({ wordCards:false });
    await chooseWord('risks'); await autoResult();
    check('关闭卡片生成后，即使保留自动保存选项也不入库', (await wordbook()).length === beforeWords);
    await setPrefs({ provider:'deepseek',preload:false,explanations:true,wordCards:true,autoSave:false,level:'B1' });
    await page.setViewport(320, 700);
    await iso(`window.__ezrSend({type:'ezr:update-settings',patch:{theme:'dark'}})`);
    await chooseWord('bank'); await click('.ezr-translate-deepseek'); await waitCard();
    check('窄窗口与深色主题下划词浮层完整可操作', await evaluate(`var p=sh.querySelector('.ezr-translation'), r=p.getBoundingClientRect();
      return !p.hidden && r.left>=0 && r.right<=document.documentElement.clientWidth && r.top>=0 && r.bottom<=innerHeight && p.scrollWidth<=p.clientWidth;`));
    await page.screenshot({ path: path.join(artifacts, 'translation-mobile-dark.png') });
    await page.setViewport(1280, 900);
    await iso(`window.__ezrSend({type:'ezr:update-settings',patch:{theme:'light'}})`);
    await options.setViewport(1040, 1100);
    await session.send('Page.bringToFront', {}, options.sessionId);
    await options.evaluate(`document.getElementById('sec-wordbook').scrollIntoView({block:'start'})`);
    await options.screenshot({ path: path.join(artifacts, 'wordbook-settings.png') });
    await options.evaluate('window.scrollTo(0,0)');
    await options.screenshot({ path: path.join(artifacts, 'translation-settings.png') });
    await options.evaluate(`document.getElementById('translation-enabled').checked=false; document.getElementById('translation-save').click();`);
    await pause(200);
    await choose(0, 35);
    check('关闭划词翻译后不再弹出浮层', await evaluate("return sh.querySelector('.ezr-translation').hidden;"));
    await options.evaluate(`document.getElementById('translation-enabled').checked=true; document.getElementById('translation-save').click();`);
    await pause(200);
    await options.evaluate(`document.getElementById('translation-remove-key').click();`);
    await pause(200);
    check('删除密钥后后台配置同步清除', !(await iso(`chrome.runtime.sendMessage({type:'ezr:translation:config'})`)).hasKey);
    await session.send('Page.close', {}, options.sessionId);
    await session.send('Page.bringToFront', {}, page.sessionId);
    await iso('window.__ezr.close()');
    check('划词翻译退出后原网页仍逐字节不变', original === await iso('document.documentElement.outerHTML'));
  } finally {
    await session.send('Fetch.disable', {}, sessionId).catch(() => {});
    off();
  }
}
