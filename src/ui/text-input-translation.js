/**
 * 输入文本翻译浮窗。位置保留在当前会话内，翻译风格与划词及全文翻译共用。
 */
import { MAX_SELECTION, MAX_STYLE_PROMPT, LANGUAGES, normalizeTranslation, translationContextKey } from '../translation/config.js';

const EDGE = 10;

/** 复制失败时返回 false，保留译文供手动复制。 */
async function copyText(doc, win, text) {
  if (!text) return false;
  try {
    if (win.navigator?.clipboard?.writeText) {
      await win.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 非安全页面或权限受限时尝试传统复制。 */ }
  let scratch;
  const focused = doc.activeElement?.shadowRoot?.activeElement || doc.activeElement;
  try {
    if (typeof doc.execCommand !== 'function' || !doc.body) return false;
    scratch = doc.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.setAttribute('aria-hidden', 'true');
    scratch.setAttribute('tabindex', '-1');
    scratch.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;pointer-events:none';
    doc.body.appendChild(scratch);
    scratch.select();
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    scratch?.remove();
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }
}

/**
 * @param {{root: HTMLElement, doc?: Document, request?: Function}} opts
 *   root 是阅读器 Shadow DOM 内的挂载点。
 */
export function createTextTranslation({ root, doc = root.ownerDocument, request = message => chrome.runtime.sendMessage(message) }) {
  const win = doc.defaultView || globalThis;
  const abort = new AbortController();
  const signal = abort.signal;
  let prefs = normalizeTranslation();
  let ready = false;
  let configRevision = 0;
  let destroyed = false;
  let selectionMode = false;
  const targetKey = () => selectionMode ? 'target' : 'textTarget';
  const requestKey = () => prefs.provider + translationContextKey(prefs, selectionMode ? 'reading' : 'text');
  let lastResult = '';
  let busy = false;
  let styleTimer = 0;
  let writes = Promise.resolve(true);
  const drafts = {};
  let stopDrag = () => {};
  let previousFocus = null;
  const viewId = crypto.randomUUID();

  const make = (tag, cls, text) => {
    const element = doc.createElement(tag);
    element.className = cls;
    if (text) element.textContent = text;
    return element;
  };
  const panel = make('div', 'ezr-text-translation');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '输入文本翻译');

  const head = make('div', 'ezr-text-head');
  const title = make('span', 'ezr-text-title', '输入文本翻译');
  const closeButton = make('button', 'ezr-text-close', '×');
  closeButton.setAttribute('aria-label', '关闭输入文本翻译');
  head.append(title, closeButton);

  const controls = make('div', 'ezr-text-controls');
  const provider = make('select', 'ezr-text-provider');
  provider.setAttribute('aria-label', '翻译服务');
  for (const [value, label] of [['free', '免费翻译'], ['deepseek', 'DeepSeek']]) {
    const option = make('option', '', label);
    option.value = value;
    provider.appendChild(option);
  }
  const target = make('select', 'ezr-text-target');
  target.setAttribute('aria-label', '目标语言');
  for (const [value, label] of LANGUAGES) {
    const option = make('option', '', label);
    option.value = value;
    target.appendChild(option);
  }
  const targetLabel = make('label', 'ezr-text-target-field');
  targetLabel.append(doc.createTextNode('译为'), target);
  controls.append(provider, targetLabel);

  const inputLabel = make('label', 'ezr-text-field');
  inputLabel.appendChild(make('span', 'ezr-text-caption', '要翻译的文字'));
  const input = make('textarea', 'ezr-text-input');
  input.setAttribute('rows', '4');
  input.setAttribute('placeholder', '输入或粘贴任意文字，最多 2000 个字符');
  input.dir = 'auto';
  inputLabel.appendChild(input);

  const styleLabel = make('label', 'ezr-text-field');
  const styleCaption = make('span', 'ezr-text-caption', '翻译风格提示词（可选，最多 ' + MAX_STYLE_PROMPT + ' 字符）');
  const style = make('textarea', 'ezr-text-style');
  style.setAttribute('rows', '2');
  style.maxLength = MAX_STYLE_PROMPT;
  style.setAttribute('placeholder', '例如：口语化一点，保留专业术语的英文原词');
  const styleHint = make('span', 'ezr-text-caption', '仅对 DeepSeek 生效，与划词及全文翻译共用。');
  styleLabel.append(styleCaption, style, styleHint);

  const actions = make('div', 'ezr-text-actions');
  const run = make('button', 'ezr-text-run', '翻译');
  const copy = make('button', 'ezr-text-copy', '复制译文');
  const clear = make('button', 'ezr-text-clear', '清空');
  const settings = make('button', 'ezr-text-settings', '翻译设置');
  copy.disabled = true;
  run.title = '翻译（Ctrl / Cmd + Enter）';
  actions.append(run, copy, clear, settings);

  const output = make('div', 'ezr-text-output');
  output.dir = 'auto';
  output.setAttribute('aria-live', 'polite');
  const status = make('div', 'ezr-text-status', '');
  status.setAttribute('role', 'status');
  panel.append(head, controls, inputLabel, styleLabel, actions, output, status);
  for (const button of panel.querySelectorAll('button')) button.type = 'button';
  root.appendChild(panel);

  function move(left, top) {
    const width = panel.offsetWidth || 380;
    const height = panel.offsetHeight || 260;
    const maxLeft = Math.max(EDGE, win.innerWidth - width - EDGE);
    const maxTop = Math.max(EDGE, win.innerHeight - height - EDGE);
    panel.style.left = Math.min(Math.max(EDGE, left), maxLeft) + 'px';
    panel.style.top = Math.min(Math.max(EDGE, top), maxTop) + 'px';
  }
  function place() {
    if (panel.style.left) {
      move(parseFloat(panel.style.left), parseFloat(panel.style.top));
    } else {
      move(Math.max(EDGE, win.innerWidth - 380 - 24), 72);
    }
  }

  // 仅标题栏响应拖动，文本域仍支持选择文字。
  head.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || event.target === closeButton) return;
    stopDrag();
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    panel.classList.add('is-dragging');
    try { head.setPointerCapture(event.pointerId); } catch { /* 文档监听仍可处理拖动。 */ }
    const onMove = moveEvent => {
      if (moveEvent.pointerId === event.pointerId) move(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
    };
    const onUp = endEvent => {
      if (endEvent?.pointerId !== undefined && endEvent.pointerId !== event.pointerId) return;
      panel.classList.remove('is-dragging');
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onUp);
      head.removeEventListener('lostpointercapture', onUp);
      win.removeEventListener('blur', onUp);
      try { head.releasePointerCapture(event.pointerId); } catch { /* 捕获已释放。 */ }
      stopDrag = () => {};
    };
    doc.addEventListener('pointermove', onMove, { signal });
    doc.addEventListener('pointerup', onUp, { signal });
    doc.addEventListener('pointercancel', onUp, { signal });
    head.addEventListener('lostpointercapture', onUp, { signal });
    win.addEventListener('blur', onUp, { signal });
    stopDrag = onUp;
    event.preventDefault();
  }, { signal });

  function render() {
    if (destroyed) return;
    provider.value = drafts.provider?.value ?? prefs.provider;
    target.value = drafts[targetKey()]?.value ?? prefs[targetKey()];
    title.textContent = selectionMode ? '所选文本翻译' : '输入文本翻译';
    panel.setAttribute('aria-label', title.textContent);
    closeButton.setAttribute('aria-label', '关闭' + title.textContent);
    target.setAttribute('aria-label', selectionMode ? '全文和划词翻译目标语言' : '输入文字翻译目标语言');
    target.title = selectionMode ? '与全文和划词翻译共用' : '仅用于输入文字翻译';
    // 回复和其他窗口的 storage 事件都不能覆盖尚未保存的输入。
    if (!drafts.stylePrompt) style.value = prefs.stylePrompt;
    const length = input.value.trim().length;
    run.disabled = busy || length === 0 || length > MAX_SELECTION;
    copy.disabled = busy || !lastResult;
    for (const control of [input, style, provider, target, clear, settings]) control.disabled = busy;
    run.textContent = busy ? '翻译中…' : '翻译';
    output.setAttribute('aria-busy', String(busy));
    if (length > MAX_SELECTION) status.textContent = '一次最多翻译 ' + MAX_SELECTION + ' 个字符，当前 ' + length + ' 个。';
    if (!panel.hidden) place();
  }

  /** 保存快照按顺序提交，新输入有独立标记，不受较早回复影响。 */
  function saveDrafts() {
    const snapshot = { ...drafts };
    if (!Object.keys(snapshot).length) return writes;
    const patch = Object.fromEntries(Object.entries(snapshot).map(([key, draft]) => [key, draft.value]));
    const job = writes.then(async () => {
      try {
        const reply = await request({ type: 'ezr:translation:preferences', patch });
        if (!reply?.ok) throw new Error(reply?.message || '设置保存失败，请重试。');
        prefs = normalizeTranslation(reply.config);
        configRevision++;
        ready = true;
        for (const [key, draft] of Object.entries(snapshot)) {
          if (drafts[key] === draft) delete drafts[key];
        }
        return true;
      } catch (error) {
        if (!destroyed) status.textContent = error.message || '设置保存失败，请重试。';
        return false;
      } finally {
        render();
      }
    });
    writes = job;
    return job;
  }
  function edit(key, value) {
    drafts[key] = { value };
    lastResult = '';
    output.textContent = '';
    status.textContent = '';
    render();
  }
  function flushSettings() {
    win.clearTimeout(styleTimer);
    styleTimer = 0;
    return saveDrafts();
  }

  provider.addEventListener('change', () => { edit('provider', provider.value); void flushSettings(); }, { signal });
  target.addEventListener('change', () => { edit(targetKey(), target.value); void flushSettings(); }, { signal });
  input.addEventListener('input', () => {
    lastResult = ''; output.textContent = ''; status.textContent = ''; render();
  }, { signal });
  style.addEventListener('input', () => {
    edit('stylePrompt', style.value);
    win.clearTimeout(styleTimer);
    styleTimer = win.setTimeout(() => { styleTimer = 0; void saveDrafts(); }, 600);
  }, { signal });

  async function translate() {
    const text = input.value.trim();
    if (destroyed || busy || !text || text.length > MAX_SELECTION) return;
    busy = true;
    lastResult = '';
    output.textContent = '正在翻译…';
    status.textContent = '';
    render();
    try {
      await initialization;
      if (!ready) await loadConfig();
      if (!await flushSettings()) throw new Error('设置未保存，已保留输入。请再次点击翻译重试。');
      if (destroyed) return;
      const key = requestKey();
      const reply = await request({
        type: 'ezr:translation:text', scope:selectionMode ? 'selection' : 'input', provider: prefs.provider, text,
        view: { id: viewId, context: '输入文本翻译' },
      });
      if (destroyed) return;
      if (key !== requestKey()) throw new Error('翻译设置已改变，请重新翻译。');
      if (!reply?.ok) throw new Error(reply?.message || '翻译失败，请重试。');
      lastResult = reply.text;
      output.textContent = reply.text;
      status.textContent = reply.cached ? '已复用上次结果' : '';
    } catch (error) {
      if (!destroyed) { output.textContent = ''; status.textContent = error.message || '翻译失败，请重试。'; }
    } finally {
      if (!destroyed) { busy = false; render(); }
    }
  }

  run.addEventListener('click', () => { void translate(); }, { signal });
  settings.addEventListener('click', async () => {
    if (!await flushSettings() || destroyed) return;
    try {
      const reply = await request({ type: 'ezr:translation:options' });
      if (!reply?.ok) throw new Error(reply?.message || '无法打开设置，请从扩展管理页打开。');
    } catch (error) {
      if (!destroyed) status.textContent = error.message || '无法打开设置，请从扩展管理页打开。';
    }
  }, { signal });
  closeButton.addEventListener('click', () => close(), { signal });
  copy.addEventListener('click', async () => {
    const ok = await copyText(doc, win, lastResult);
    if (!destroyed) status.textContent = ok ? '译文已复制到剪贴板。' : '复制失败，请手动选中译文复制。';
  }, { signal });
  clear.addEventListener('click', () => {
    input.value = ''; output.textContent = ''; lastResult = ''; status.textContent = '';
    render();
    input.focus();
  }, { signal });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void translate(); }
  }, { signal });

  function open() {
    if (destroyed) return;
    if (panel.hidden) previousFocus = root.getRootNode().activeElement || doc.activeElement;
    panel.hidden = false;
    render();
    input.focus();
  }
  function close() {
    if (destroyed || panel.hidden) return;
    const focused = root.getRootNode().activeElement || doc.activeElement;
    const restoreFocus = panel.contains(focused);
    void flushSettings();
    stopDrag();
    panel.hidden = true;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  win.addEventListener('resize', () => { if (!panel.hidden) place(); }, { signal });

  const changed = (changes, area) => {
    if (area !== 'local' || !changes?.['ezr:translation:config'] || destroyed) return;
    const before = requestKey();
    prefs = normalizeTranslation(changes['ezr:translation:config'].newValue);
    if (before !== requestKey()) { lastResult = ''; output.textContent = ''; }
    configRevision++;
    ready = true;
    render();
  };
  try { chrome.storage?.onChanged?.addListener(changed); } catch { /* 非扩展环境。 */ }

  async function loadConfig() {
    const revision = configRevision;
    const reply = await request({ type: 'ezr:translation:config' });
    if (destroyed) return;
    if (!reply?.ok) throw new Error(reply?.message || '无法读取翻译设置，请点击翻译重试。');
    if (revision === configRevision) prefs = normalizeTranslation(reply.config);
    ready = true;
    render();
  }
  const initialization = loadConfig().catch(error => {
    if (!destroyed) status.textContent = error.message || '无法读取翻译设置，请点击翻译重试。';
    render();
  });
  render();

  return {
    element: panel, open, close,
    openText(text, runNow = false, selectedText = false) {
      if (destroyed || busy) return;
      selectionMode = selectedText;
      input.value = text; lastResult = ''; output.textContent = ''; status.textContent = '';
      open();
      if (runNow) void translate();
    },
    toggle() {
      if (busy && selectionMode) { open(); return; }
      if (selectionMode) { selectionMode = false; lastResult = ''; output.textContent = ''; status.textContent = ''; open(); }
      else if (panel.hidden) open(); else close();
    },
    get isOpen() { return !panel.hidden; },
    destroy() {
      if (destroyed) return;
      void flushSettings();
      stopDrag();
      destroyed = true;
      abort.abort();
      try { chrome.storage?.onChanged?.removeListener(changed); } catch { /* 非扩展环境。 */ }
      panel.remove();
    },
  };
}
