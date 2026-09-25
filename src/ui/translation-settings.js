import { LANGUAGES, MODELS, ENGLISH_LEVELS, TRANSLATION_KEY, normalizeTranslation } from '../translation/config.js';

/** Shared translation preferences. Credentials stay on the extension's options page. */
export function createTranslationSettings(container, { doc = container.ownerDocument,
  request = message => chrome.runtime.sendMessage(message) } = {}) {
  let prefs = normalizeTranslation(), ready = false, busy = false, destroyed = false, original = false, revision = 0;
  const controls = new Map();
  const make = (tag, cls, text) => {
    const element = doc.createElement(tag); element.className = cls;
    if (text) element.textContent = text;
    return element;
  };
  const add = (key, label, description, options, parent = container) => {
    const row = make('label', options ? 'ezr-field' : 'ezr-field ezr-field-check');
    const copy = make('span', 'ezr-switch-copy');
    copy.appendChild(make('span', 'ezr-field-label', label));
    if (description) copy.appendChild(make('span', 'ezr-field-description', description));
    const input = make(options ? 'select' : 'input', options ? 'ezr-select' : 'ezr-check');
    input.setAttribute('data-ezr-translation-setting', key);
    input.setAttribute('aria-label', label);
    if (options) for (const [value, text] of options) {
      const option = make('option', '', text); option.value = value; input.appendChild(option);
    }
    else { input.type = 'checkbox'; input.setAttribute('role', 'switch'); }
    input.addEventListener('change', () => {
      if (!input.disabled) void save({ [key]: options ? input.value : input.checked });
    });
    row.append(copy, input); parent.appendChild(row); controls.set(key, input);
  };
  container.appendChild(make('p', 'ezr-field-description', '划词翻译开关位于翻译工具栏，开启后选中文字即可显示浮窗。'));
  add('preload', '划词后自动翻译', '选区稳定后，仅请求当前所选服务');
  add('provider', '翻译服务', '', [['free', '免费翻译'], ['deepseek', 'DeepSeek']]);
  add('source', '原文语言', '', [['auto', '自动识别'], ...LANGUAGES]);
  add('target', '全文与划词目标语言', '也可在翻译工具栏中切换', LANGUAGES);
  add('model', 'DeepSeek 模型', '', MODELS.map(model => [model, model]));
  const learning = make('div', 'ezr-settings-learning');
  learning.appendChild(make('h4', 'ezr-settings-subtitle', '词语学习'));
  add('explanations', '生成词语讲解', '免费翻译查词典，AI 根据语境讲解', null, learning);
  add('wordCards', '生成生词卡', '可导出 Anki，生成后不会自动收藏', null, learning);
  add('autoSave', '自动加入生词本', '将生成的卡片自动保存', null, learning);
  add('level', '英语水平', 'AI 按此水平挑选生词并讲解', ENGLISH_LEVELS, learning);
  container.appendChild(learning);
  const advanced = make('button', 'ezr-translation-config', 'API 密钥与生词本'); advanced.type = 'button';
  const status = make('p', 'ezr-field-description ezr-translation-settings-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const retry = make('button', 'ezr-translation-config', '重新加载翻译设置'); retry.type = 'button'; retry.hidden = true;
  container.append(advanced, status, retry);
  const selectionKeys = new Set(['preload', 'explanations', 'wordCards', 'autoSave', 'level']);
  function render() {
    if (destroyed) return;
    for (const [key, input] of controls) {
      if (input.type === 'checkbox') input.checked = prefs[key]; else input.value = prefs[key];
      input.disabled = !ready || busy || (selectionKeys.has(key) && !prefs.enabled)
        || (['explanations','wordCards','autoSave','level'].includes(key) && original)
        || (key === 'autoSave' && !prefs.wordCards)
        || (key === 'level' && (prefs.provider !== 'deepseek' || (!prefs.wordCards && !prefs.explanations)))
        || (key === 'model' && prefs.provider !== 'deepseek');
    }
    learning.hidden = original;
  }
  async function load() {
    const token = ++revision;
    retry.hidden = true; status.textContent = '正在读取翻译设置…';
    try {
      const reply = await request({ type: 'ezr:translation:config' });
      if (destroyed || token !== revision) return;
      if (!reply?.ok) throw new Error(reply?.message || '无法读取翻译设置。');
      prefs = normalizeTranslation(reply.config); ready = true; status.textContent = '';
    } catch (error) {
      if (destroyed || token !== revision) return;
      status.textContent = error.message; retry.hidden = false;
    }
    render();
  }
  async function save(patch) {
    if (!ready || busy || destroyed) return;
    const previous = prefs, token = ++revision;
    busy = true; prefs = normalizeTranslation({ ...prefs, ...patch }); render(); status.textContent = '正在保存…';
    try {
      const reply = await request({ type: 'ezr:translation:preferences', patch });
      if (destroyed) return;
      if (!reply?.ok) throw new Error(reply?.message || '翻译设置保存失败。');
      if (token === revision) prefs = normalizeTranslation(reply.config);
      status.textContent = '已保存，所有网页共用。';
    } catch (error) {
      if (!destroyed) { if (token === revision) prefs = previous; status.textContent = error.message; }
    }
    finally { busy = false; render(); }
  }
  advanced.addEventListener('click', async () => {
    try {
      const result = await request({ type: 'ezr:translation:options' });
      if (!result?.ok) throw new Error(result?.message || '无法打开扩展设置。');
    } catch (error) { if (!destroyed) status.textContent = error.message; }
  });
  retry.addEventListener('click', () => { void load(); });
  const changed = (changes, area) => {
    if (area !== 'local' || !changes[TRANSLATION_KEY] || destroyed) return;
    revision++; ready = true; prefs = normalizeTranslation(changes[TRANSLATION_KEY].newValue);
    if (!busy) { status.textContent = ''; retry.hidden = true; }
    render();
  };
  chrome.storage.onChanged.addListener(changed);
  render(); void load();
  return {
    setPreviewing(value) { original = !!value; render(); },
    destroy() { destroyed = true; revision++; chrome.storage.onChanged.removeListener(changed); },
  };
}
