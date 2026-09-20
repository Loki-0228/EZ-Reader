const button = document.getElementById('primary');
const notice = document.getElementById('notice');
let tabId;
function status(text) { notice.textContent = text; notice.hidden = !text; }
async function init() {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab || !/^(https?|file):/.test(tab.url || '')) {
      status('此页面不支持工具栏，请切换到普通网页后打开。'); return;
    }
    tabId = tab.id; button.disabled = false;
  } catch { status('无法读取当前网页，请重新打开扩展面板。'); }
}
button.addEventListener('click', async () => {
  if (button.disabled) return;
  button.disabled = true; status('');
  try {
    const reply = await chrome.runtime.sendMessage({type:'ezr:window-toolbar:set',tabId,enabled:true});
    if (!reply?.ok) throw new Error(reply?.message || '工具栏未能打开，请重试。');
    if (!reply.available) throw new Error('当前网页无法显示工具栏，请刷新页面或检查扩展的网站访问权限。');
    window.close();
  } catch (error) { status(error.message); button.disabled = false; }
});
void init();
