import { openPdfForTab } from '../background/documents.js';
const button = document.getElementById('primary');
const notice = document.getElementById('notice');
let tabId, currentTab;
let nativeDocument = false;
function status(text) { notice.textContent = text; notice.hidden = !text; }
async function init() {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    currentTab = tab; tabId = tab?.id;
    if (!tab || !/^(https?|file):/.test(tab.url || '')) {
      status('此页面无法显示网页工具栏，可用「打开 PDF」打开文档。'); return;
    }
    nativeDocument = /\.(pdf)(?:[?#]|$)/i.test(tab.url);
    if (nativeDocument) button.textContent = '打开 PDF 工具栏';
    tabId = tab.id; button.disabled = false;
  } catch { status('无法读取当前网页，请重新打开扩展面板。'); }
}
button.addEventListener('click', async () => {
  if (button.disabled) return;
  button.disabled = true; status('');
  try {
    if (nativeDocument) { await openDocuments(); return; }
    const reply = await chrome.runtime.sendMessage({type:'ezr:window-toolbar:set',tabId,enabled:true});
    if (!reply?.ok) throw new Error(reply?.message || '工具栏未能打开，请重试。');
    if (!reply.available) throw new Error('当前网页无法显示工具栏，请刷新页面或检查扩展的网站访问权限。');
    window.close();
  } catch (error) { status(error.message); button.disabled = false; }
});
async function openDocuments() {
  const reply = await openPdfForTab(currentTab);
  if (!reply?.ok) throw new Error(reply?.message || 'PDF 窗口未能打开，请重新加载扩展后再试。');
  window.close();
}
document.getElementById('documents').addEventListener('click', () => { void openDocuments().catch(error => status(error.message)); });
void init();
