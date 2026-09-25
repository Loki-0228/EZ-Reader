import { LANGUAGES, MODELS, ENGLISH_LEVELS, TRANSLATION_KEY, normalizeTranslation } from '../translation/config.js';

const byId = id => document.getElementById(id);
const status = byId('translation-status');
let current = normalizeTranslation();
let dirty = false, busy = false, revision = 0;
const call = async message => {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.message || '扩展后台未响应，请重新加载扩展。');
  return reply;
};
function fill(id, pairs) {
  for (const [value, label] of pairs) {
    const option = document.createElement('option');
    option.value = value; option.textContent = label;
    byId(id).appendChild(option);
  }
}
function render(reply) {
  revision++; dirty = false;
  current = reply.config;
  byId('translation-source').value = current.source;
  byId('translation-target').value = current.target;
  byId('translation-model').value = current.model;
  byId('translation-provider').value = current.provider;
  byId('translation-preload').checked = current.preload;
  byId('translation-explanations').checked = current.explanations;
  byId('translation-word-cards').checked = current.wordCards;
  byId('translation-auto-save').checked = current.autoSave;
  byId('translation-level').value = current.level;
  dependencies();
  byId('translation-key').value = '';
  byId('translation-key').placeholder = reply.hasKey ? '已保存密钥；留空保持不变' : '填写 DeepSeek API Key';
  byId('translation-key-state').textContent = reply.hasKey ? '已配置 DeepSeek' : '未配置 DeepSeek，免费翻译仍可使用';
}
function dependencies() {
  byId('translation-auto-save').disabled = !byId('translation-word-cards').checked;
  byId('translation-level').disabled = !byId('translation-word-cards').checked && !byId('translation-explanations').checked;
}
async function act(action, success) {
  busy = true;
  status.textContent = '处理中…';
  const buttons = document.querySelectorAll('#sec-translation button');
  buttons.forEach(button => { button.disabled = true; });
  try { await action(); status.textContent = success; }
  catch (error) { status.textContent = error.message; }
  finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
}
for (const type of ['input', 'change']) byId('sec-translation').addEventListener(type, () => { dirty = true; });
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[TRANSLATION_KEY] || dirty || busy) return;
  const token = ++revision;
  try {
    const reply = await call({ type: 'ezr:translation:config' });
    if (token === revision && !dirty && !busy) render(reply);
  } catch { /* The next explicit save still reports errors normally. */ }
});
fill('translation-source', [['auto', '自动识别'], ...LANGUAGES]);
fill('translation-target', LANGUAGES);
fill('translation-model', MODELS.map(model => [model, model === 'deepseek-flash' ? `${model}（推荐）` : model]));
fill('translation-provider', [['free', '免费翻译'], ['deepseek', 'DeepSeek']]);
fill('translation-level', ENGLISH_LEVELS);
byId('translation-word-cards').addEventListener('change', dependencies);
byId('translation-explanations').addEventListener('change', dependencies);
byId('translation-save').addEventListener('click', () => act(async () => {
  const message = { type: 'ezr:translation:save', config: {
    source: byId('translation-source').value,
    target: byId('translation-target').value, model: byId('translation-model').value,
    provider: byId('translation-provider').value, preload: byId('translation-preload').checked,
    explanations: byId('translation-explanations').checked,
    wordCards: byId('translation-word-cards').checked, autoSave: byId('translation-auto-save').checked,
    level: byId('translation-level').value,
  } };
  const key = byId('translation-key').value.trim();
  if (key) message.apiKey = key;
  render(await call(message));
}, '翻译设置已保存，已打开的阅读视图也会更新。'));
byId('translation-remove-key').addEventListener('click', () => act(async () => {
  render(await call({ type: 'ezr:translation:save', apiKey: '' }));
}, 'DeepSeek 密钥已删除。'));
byId('translation-clear').addEventListener('click', () => act(async () => {
  await call({ type: 'ezr:translation:clear-all' });
}, '所有翻译语境已清除，下次使用 DeepSeek 时重新分析。'));
void act(async () => render(await call({ type: 'ezr:translation:config' })), '');
