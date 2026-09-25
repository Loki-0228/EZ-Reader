import { openPdfForTab } from '../background/documents.js';
const button = document.getElementById('primary');
const buttonLabel = document.getElementById('primary-label');
const notice = document.getElementById('notice');
let tabId, currentTab;
let nativeDocument = false;
let toolbarEnabled = false;
let canOpenToolbar = false;
let toolbarVisible = null; // null = 无法向当前页探测（内容脚本不可达），按窗口开关兜底
let showing = false;
function status(text) { notice.textContent = text; notice.hidden = !text; }
function updateToolbarButton(state) {
  toolbarEnabled = state.enabled === true;
  // 主栏被 × 藏掉或尚未显示时，按钮回到「打开」语义，与页面上看到的一致。
  showing = toolbarEnabled && (toolbarVisible === null ? true : toolbarVisible);
  buttonLabel.textContent = showing ? '关闭工具栏' : nativeDocument ? '打开 PDF 工具栏' : '网页工具栏';
  button.title = showing ? '关闭当前浏览器窗口内的网页工具栏'
    : toolbarEnabled && !nativeDocument ? '重新显示网页工具栏' : buttonLabel.textContent;
}
async function probeToolbarVisible() {
  // 每个 frame 都应答 ezr:status，只认主框架的应答，其余再问一次。
  for (let ask = 0; ask < 3; ask++) {
    let reply = null;
    try { reply = await chrome.tabs.sendMessage(tabId, { type: 'ezr:status' }); } catch { return null; }
    if (reply?.topFrame) return reply.toolbarVisible === true;
    if (!reply?.ok) return null;
  }
  return null;
}
async function readToolbarState() {
  const reply = await chrome.runtime.sendMessage({type:'ezr:window-toolbar:get',tabId});
  if (!reply?.ok) throw new Error(reply?.message || '无法读取工具栏状态，请重新打开扩展面板。');
  toolbarVisible = await probeToolbarVisible();
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
  const enabled = !showing;
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
