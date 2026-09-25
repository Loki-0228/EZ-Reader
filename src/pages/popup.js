import { openPdfForTab } from '../background/documents.js';
const button = document.getElementById('primary');
const buttonLabel = document.getElementById('primary-label');
const notice = document.getElementById('notice');
let tabId, currentTab;
let nativeDocument = false;
let toolbarEnabled = false;
let canOpenToolbar = false;
function status(text) { notice.textContent = text; notice.hidden = !text; }
function updateToolbarButton(state) {
  toolbarEnabled = state.enabled === true;
  buttonLabel.textContent = toolbarEnabled ? '关闭工具栏' : nativeDocument ? '打开 PDF 工具栏' : '网页工具栏';
  button.title = toolbarEnabled ? '关闭当前浏览器窗口内的网页工具栏' : buttonLabel.textContent;
}
async function readToolbarState() {
  const reply = await chrome.runtime.sendMessage({type:'ezr:window-toolbar:get',tabId});
  if (!reply?.ok) throw new Error(reply?.message || '无法读取工具栏状态，请重新打开扩展面板。');
  updateToolbarButton(reply);
}
async function init() {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!Number.isInteger(tab?.id)) throw new Error('未找到当前标签页，请重新打开扩展面板。');
    currentTab = tab; tabId = tab.id;
    canOpenToolbar = /^(https?|file):/.test(tab.url || '');
    nativeDocument = /\.(pdf)(?:[?#]|$)/i.test(tab.url || '');
    // Read the background state even when this page cannot host a toolbar.
    await readToolbarState();
    button.disabled = !toolbarEnabled && !canOpenToolbar;
    if (!canOpenToolbar) {
      status(toolbarEnabled
        ? '此页面无法显示网页工具栏，仍可关闭当前窗口的工具栏。'
        : '此页面无法显示网页工具栏，可用「打开 PDF」打开文档。');
    }
  } catch (error) { status(error.message || '无法读取当前网页，请重新打开扩展面板。'); }
}
button.addEventListener('click', async () => {
  if (button.disabled) return;
  button.disabled = true; status('');
  const enabled = !toolbarEnabled;
  try {
    if (enabled && nativeDocument) { await openDocuments(); return; }
    const reply = await chrome.runtime.sendMessage({type:'ezr:window-toolbar:set',tabId,enabled});
    if (!reply?.ok) throw new Error(reply?.message || (enabled ? '工具栏未能打开，请重试。' : '工具栏未能关闭，请重试。'));
    // The switch is saved even if the current page cannot display the toolbar.
    updateToolbarButton(reply);
    if (enabled && !reply.available) {
      throw new Error('当前网页无法显示工具栏，可点击「关闭工具栏」停止启用，或检查扩展的网站访问权限后重试。');
    }
    window.close();
  } catch (error) {
    // A delivery failure can happen after the background has saved the switch.
    await readToolbarState().catch(() => {});
    status(error.message);
    button.disabled = !toolbarEnabled && !canOpenToolbar;
  }
});
async function openDocuments() {
  const reply = await openPdfForTab(currentTab);
  if (!reply?.ok) throw new Error(reply?.message || 'PDF 窗口未能打开，请重新加载扩展后再试。');
  window.close();
}

document.getElementById('documents').addEventListener('click', () => { void openDocuments().catch(error => status(error.message)); });
void init();
