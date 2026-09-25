import { createTranslationService } from './service.js';
import { normalizeTranslation, TRANSLATION_KEY, translationContextKey } from './config.js';
import { createCredentialStore } from './credentials.js';
import { createWordbook } from './wordbook.js';

const CONTEXT_PREFIX = 'ezr:translation:context:';

/** Registered only in the MV3 worker. Credentials are never returned in reader messages. */
export function registerTranslation(chromeApi = chrome) {
  const credentials = createCredentialStore();
  const wordbook = createWordbook(chromeApi.storage.local);
  let preferenceWrites = Promise.resolve();
  function writeConfig(work) {
    const job = preferenceWrites.then(work);
    preferenceWrites = job.catch(() => {});
    return job;
  }
  const session = chromeApi.storage.session;
  const service = createTranslationService({
    detectLanguage: text => chromeApi.i18n.detectLanguage(text),
    saved: {
      get: async slot => (await session.get(CONTEXT_PREFIX + slot))[CONTEXT_PREFIX + slot],
      set: async (slot, value) => {
        await session.set({ [CONTEXT_PREFIX + slot]: value });
        const data = await session.get(null);
        const keys = Object.keys(data).filter(key => key.startsWith(CONTEXT_PREFIX))
          .sort((a, b) => data[b].ts - data[a].ts);
        const stale = keys.filter((key, index) => index >= 16 || Date.now() - data[key].ts > 30 * 60 * 1000);
        if (stale.length) await session.remove(stale);
      },
      remove: slot => session.remove(CONTEXT_PREFIX + slot),
      clear: async prefix => {
        const data = await session.get(null);
        const keys = Object.keys(data).filter(key => key.startsWith(CONTEXT_PREFIX + (prefix || '')));
        if (keys.length) await session.remove(keys);
      },
    },
  });
  function clearChangedConfig(before, after) {
    const readingChanged = translationContextKey(before) !== translationContextKey(after);
    const textChanged = translationContextKey(before, 'text') !== translationContextKey(after, 'text');
    if (readingChanged && textChanged) service.clear();
    else if (readingChanged || textChanged) service.clearScope(textChanged ? 'text' : 'reading');
  }
  const slotOf = sender => Number.isInteger(sender.tab?.id) ? `${sender.tab.id}:${sender.frameId || 0}` : `reader:${sender.documentId}`;
  // Chrome's sender.url can retain the document's initial URL after history.pushState.
  const isDocumentReader = sender => sender.url?.split(/[?#]/)[0] === chromeApi.runtime.getURL('pages/document-reader.html');
  const pageUrlOf = sender => {
    const url = !sender.frameId ? sender.tab?.url || sender.url : sender.url;
    return /^(about:|data:|blob:)/.test(url || '') ? (/^(https?|file):/.test(sender.origin || '') ? sender.origin : sender.tab?.url) : url;
  };
  const isOptions = sender => sender.id === chromeApi.runtime.id && sender.url === chromeApi.runtime.getURL('pages/options.html');
  async function handle(message, sender) {
    if (sender.id !== chromeApi.runtime.id) throw new Error('不允许此来源调用翻译。');
    if (message.type === 'ezr:translation:preferences') {
      return writeConfig(async () => {
        const bag = await chromeApi.storage.local.get(TRANSLATION_KEY);
        const patch = {};
        for (const key of ['enabled', 'provider', 'preload', 'source', 'target', 'textTarget', 'model', 'explanations', 'wordCards', 'autoSave', 'level', 'stylePrompt']) {
          if (Object.hasOwn(message.patch || {}, key)) patch[key] = message.patch[key];
        }
        const config = normalizeTranslation({ ...normalizeTranslation(bag[TRANSLATION_KEY]), ...patch });
        await chromeApi.storage.local.set({ [TRANSLATION_KEY]: config });
        return { ok: true, config };
      });
    }
    if (message.type === 'ezr:translation:cards-list') {
      if (!isOptions(sender)) throw new Error('请在扩展设置页查看生词本。');
      return { ok: true, cards: await wordbook.list() };
    }
    if (message.type === 'ezr:translation:cards-remove') {
      if (!isOptions(sender)) throw new Error('请在扩展设置页管理生词本。');
      await wordbook.remove(message.id);
      return { ok: true };
    }
    if (['ezr:translation:cards-save', 'ezr:translation:cards-save-many'].includes(message.type)) {
      if (!Number.isInteger(sender.tab?.id) && !(isDocumentReader(sender) && sender.documentId)) throw new Error('请在阅读视图中保存单词卡。');
      if (message.automatic) {
        const config = normalizeTranslation((await chromeApi.storage.local.get(TRANSLATION_KEY))[TRANSLATION_KEY]);
        if (!config.enabled || !config.wordCards || !config.autoSave) return { ok: true, skipped: true };
      }
      const cards = message.type.endsWith('save-many') ? message.cards : [message.card];
      if (!Array.isArray(cards)) throw new Error('生词卡格式无效。');
      return { ok: true, ...(await wordbook.saveMany(cards.map(card => ({ ...card, pageUrl: pageUrlOf(sender) })))) };
    }
    const bag = await chromeApi.storage.local.get(TRANSLATION_KEY);
    const config = normalizeTranslation(bag[TRANSLATION_KEY]);
    if (message.type === 'ezr:translation:config') return { ok: true, config, hasKey: !!(await credentials.get()) };
    if (message.type === 'ezr:translation:options') {
      await chromeApi.runtime.openOptionsPage();
      return { ok: true };
    }
    if (message.type === 'ezr:translation:save') {
      if (!isOptions(sender)) throw new Error('请在扩展设置页修改翻译配置。');
      return writeConfig(async () => {
        // Read inside the same queue as reader preferences so neither writer loses fields.
        const stored = (await chromeApi.storage.local.get(TRANSLATION_KEY))[TRANSLATION_KEY] || {};
        const merged = normalizeTranslation(stored);
        for (const [key, value] of Object.entries(message.config || {})) {
          if (value !== undefined) merged[key] = value;
        }
        const next = normalizeTranslation(merged);
        if (typeof message.apiKey === 'string') {
          const apiKey = message.apiKey.trim();
          if (apiKey && !/^[\x21-\x7E]{10,256}$/.test(apiKey)) throw new Error('API Key 格式无效。');
          await credentials.set(apiKey);
        }
        await chromeApi.storage.local.set({ [TRANSLATION_KEY]: next });
        if (typeof message.apiKey === 'string') service.clear();
        else clearChangedConfig(stored, next);
        return { ok: true, config: next, hasKey: !!(await credentials.get()) };
      });
    }
    if (message.type === 'ezr:translation:clear-all') {
      if (!isOptions(sender)) throw new Error('请在扩展设置页清除翻译语境。');
      service.clear();
      return { ok: true };
    }
    if (!Number.isInteger(sender.tab?.id) && !(isDocumentReader(sender) && sender.documentId)) throw new Error('请在阅读视图中划词翻译。');
    if (message.type === 'ezr:translation:clear') {
      service.clearFrame(slotOf(sender));
      return { ok: true };
    }
    if (!['ezr:translation:run', 'ezr:translation:text', 'ezr:translation:learn', 'ezr:translation:vocabulary', 'ezr:translation:full'].includes(message.type)) throw new Error('未知翻译请求。');
    const url = new URL(pageUrlOf(sender));
    if (!['http:', 'https:', 'file:'].includes(url.protocol) && !isDocumentReader(sender)) throw new Error('当前页面不支持翻译。');
    const operation = message.type === 'ezr:translation:full' ? service.full : message.type === 'ezr:translation:learn' ? service.learn : message.type === 'ezr:translation:vocabulary' ? service.vocabulary : service.translate;
    const provider = message.type === 'ezr:translation:full' ? message.provider || config.provider : message.provider;
    // Free-form input keeps its own session so it never evicts the reader's
    // context and translation cache for the same tab and frame.
    const isText = message.type === 'ezr:translation:text';
    const selectedText = isText && message.scope === 'selection';
    const slot = isText ? `${slotOf(sender)}/${selectedText ? 'selected-text' : 'text'}` : slotOf(sender);
    const requestConfig = isText && !selectedText ? { ...config, target:config.textTarget } : config;
    const result = await operation({
      slot, documentId: sender.documentId || '', url: url.href,
      view: isText ? { ...message.view, fullDocument:false } : message.view, text: message.text, nearby: message.nearby, provider,
      freeform: message.type === 'ezr:translation:text',
      translation: message.translation, sourceLanguage: message.sourceLanguage,
      texts: message.texts,
    }, requestConfig, provider === 'deepseek' ? await credentials.get() : '');
    return { ok: true, ...result };
  }
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith('ezr:translation:')) return undefined;
    handle(message, sender).then(sendResponse).catch(error => {
      sendResponse({ ok: false, message: error instanceof Error ? error.message : '翻译失败，请重试。' });
    });
    return true;
  });
  chromeApi.tabs.onRemoved.addListener(tabId => service.clear(`${tabId}:`));
  chromeApi.tabs.onUpdated.addListener((tabId, change) => { if (change.url || change.status === 'loading') service.clear(`${tabId}:`); });
  chromeApi.storage.onChanged.addListener((changes, area) => {
    const change = changes[TRANSLATION_KEY];
    if (area === 'local' && change) clearChangedConfig(change.oldValue, change.newValue);
  });
  return service;
}
