const ENTRY_PREFIX = 'ezr:document:entry:';
const READER = 'pages/document-reader.html';
const TTL = 30 * 60 * 1000;
const nonPdf = /\.(?:pptx?|docx?|xlsx?|od[pts]|rtf)(?:[?#]|$)/i;
function safeUrl(raw) {
  try { const url = new URL(raw); return ['http:', 'https:', 'file:', 'blob:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}
function sourceFor(raw, name = '', depth = 0) {
  if (depth > 4 || nonPdf.test(name)) return null;
  try {
    const url = new URL(raw);
    if (!safeUrl(url.href) || nonPdf.test(url.pathname)) return null;
    for (const key of ['file', 'src', 'url']) {
      const nested = url.searchParams.get(key);
      if (nested && safeUrl(nested)) { const source = sourceFor(nested, name, depth + 1); if (source) return source; }
    }
    const canvas = /\/files\/\d+\/(?:download|preview|file_download|file_preview)\/?$/i.test(url.pathname);
    if (!canvas && !/\.pdf$/i.test(url.pathname)) return null;
    if (canvas) url.pathname = url.pathname.replace(/\/(?:preview|file_preview)\/?$/i, '/download');
    return { url:url.href, name:String(name || decodeURIComponent(url.pathname.split('/').pop()) || 'PDF').slice(0,240), kind:canvas ? 'document' : 'pdf' };
  } catch { return null; }
}
/** Shared with the action popup, so opening a PDF does not depend on a worker reply. */
export async function discoverPdfSources(tab, api = chrome) {
  const direct = sourceFor(tab?.url || '', tab?.title);
  if (direct) return [direct];
  const items = []; let inaccessible = false;
  if (!Number.isInteger(tab?.id)) return items;
  try {
    await api.scripting.executeScript({ target:{ tabId:tab.id, allFrames:true }, files:['content.js'] }).catch(() => {});
    const frames = await api.scripting.executeScript({ target:{ tabId:tab.id, allFrames:true }, func:() => globalThis.__ezrDocumentSources?.() || [] });
    for (const frame of frames) for (const candidate of Array.isArray(frame.result) ? frame.result : []) {
      const url = safeUrl(candidate.url);
      if (url && !nonPdf.test(url) && !nonPdf.test(candidate.name || '') && ['pdf','document'].includes(candidate.kind)
        && items.length < 24 && !items.some(item => item.url === url)) {
        items.push({ url, name:String(candidate.name || 'PDF').slice(0,240), kind:candidate.kind, frameId:frame.frameId });
      }
    }
  } catch { inaccessible = true; }
  // PDF responses may use a download URL without a .pdf suffix. Only an explicit
  // PDF-open action reaches this fallback; the reader verifies the file signature.
  const candidate = safeUrl(tab.url || '');
  if (!items.length && candidate && !nonPdf.test(candidate) && !nonPdf.test(tab.title || '')
    && (inaccessible || /\.pdf(?:$|\s)/i.test(tab.title || ''))) {
    items.push({ url:candidate, name:String(tab.title || 'PDF').slice(0,240), kind:'document' });
  }
  return items;
}
export async function createPdfEntry(value, api = chrome) {
  const data = await api.storage.session.get(null);
  const keys = Object.keys(data).filter(key => key.startsWith(ENTRY_PREFIX)).sort((a,b) => (data[b]?.created || 0) - (data[a]?.created || 0));
  const expired = keys.filter((key,index) => index >= 15 || Date.now() - (data[key]?.created || 0) > TTL);
  if (expired.length) await api.storage.session.remove(expired);
  const id = crypto.randomUUID();
  await api.storage.session.set({ [ENTRY_PREFIX + id]:{ ...value, created:Date.now() } });
  const tab = await api.tabs.create({ url:api.runtime.getURL(READER) + '#' + id });
  return { ok:true, tabId:tab.id };
}
export async function openPdfForTab(tab, api = chrome) {
  return createPdfEntry({ sources:await discoverPdfSources(tab, api), sourceTabId:tab?.id, title:tab?.title || 'PDF 阅读' }, api);
}
export function registerDocuments(api = chrome) {
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith('ezr:documents:')) return;
    const work = (async () => {
      if (sender.id !== api.runtime.id) throw new Error('不允许此来源打开 PDF。');
      if (message.type === 'ezr:documents:entry') {
        if (sender.url?.split(/[?#]/)[0] !== api.runtime.getURL(READER) || !/^[\da-f-]{36}$/i.test(message.id || '')) throw new Error('PDF 入口无效，请重新打开。');
        const entry = (await api.storage.session.get(ENTRY_PREFIX + message.id))[ENTRY_PREFIX + message.id];
        if (!entry || Date.now() - entry.created > TTL) throw new Error('PDF 入口已过期，请从原页面重新打开。');
        return { ok:true, entry };
      }
      if (message.type !== 'ezr:documents:open') throw new Error('未知 PDF 请求。');
      const ownPage = sender.url?.startsWith(api.runtime.getURL('pages/'));
      const tabId = sender.tab?.id ?? (ownPage ? message.tabId : undefined);
      return openPdfForTab(Number.isInteger(tabId) ? await api.tabs.get(tabId) : null, api);
    })();
    work.then(respond).catch(error => respond({ ok:false, message:error.message }));
    return true;
  });
  const items = [
    { id:'ezr-selected-text', title:'用 EZ-Reader 翻译所选文本', contexts:['selection'] },
    { id:'ezr-document-read', title:'用 EZ-Reader 打开 PDF', contexts:['page','frame','link'] },
  ];
  const install = () => {
    for (const { id, ...properties } of items) api.contextMenus.update(id, properties, () => {
      if (api.runtime.lastError) api.contextMenus.create({ id, ...properties }, () => { void api.runtime.lastError; });
    });
  };
  api.runtime.onInstalled.addListener(install); api.runtime.onStartup.addListener(install); install();
  api.contextMenus.onClicked.addListener((info, tab) => {
    if (!items.some(item => item.id === info.menuItemId)) return;
    const work = info.menuItemId === 'ezr-selected-text'
      ? createPdfEntry({ title:tab?.title || '所选文本', sources:[], selectionText:String(info.selectionText || '') }, api)
      : (async () => {
        const source = sourceFor(info.linkUrl || info.srcUrl || info.frameUrl);
        if (source) return createPdfEntry({ title:tab?.title || 'PDF 阅读', sources:[source], sourceTabId:tab?.id }, api);
        return openPdfForTab(tab, api);
      })();
    void work.catch(error => console.warn('[EZ-Reader] PDF 入口打开失败', error.message));
  });
}