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
  const slotOf = sender => `${sender.tab.id}:${sender.frameId || 0}`;
  // Chrome's sender.url can retain the document's initial URL after history.pushState.
  const pageUrlOf = sender => !sender.frameId ? sender.tab?.url || sender.url : sender.url;
  const isOptions = sender => sender.id === chromeApi.runtime.id && sender.url === chromeApi.runtime.getURL('pages/options.html');
  async function handle(message, sender) {
    if (sender.id !== chromeApi.runtime.id) throw new Error('不允许此来源调用翻译。');
    if (message.type === 'ezr:translation:preferences') {
      const job = preferenceWrites.then(async () => {
        const bag = await chromeApi.storage.local.get(TRANSLATION_KEY);
        const patch = {};
        for (const key of ['enabled', 'provider', 'preload', 'source', 'target', 'model', 'explanations', 'wordCards', 'autoSave', 'level']) {
          if (Object.hasOwn(message.patch || {}, key)) patch[key] = message.patch[key];
        }
        const config = normalizeTranslation({ ...bag[TRANSLATION_KEY], ...patch });
        await chromeApi.storage.local.set({ [TRANSLATION_KEY]: config });
        return { ok: true, config };
      });
      preferenceWrites = job.catch(() => {});
      return job;
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
      if (!Number.isInteger(sender.tab?.id)) throw new Error('请在阅读视图中保存单词卡。');
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
      const patch = { [TRANSLATION_KEY]: normalizeTranslation(message.config) };
      if (typeof message.apiKey === 'string') {
        const apiKey = message.apiKey.trim();
        if (apiKey && !/^[\x21-\x7E]{10,256}$/.test(apiKey)) throw new Error('API Key 格式无效。');
        await credentials.set(apiKey);
      }
      await chromeApi.storage.local.set(patch);
      if (typeof message.apiKey === 'string' || translationContextKey(config) !== translationContextKey(patch[TRANSLATION_KEY])) service.clear();
      return { ok: true, config: patch[TRANSLATION_KEY], hasKey: !!(await credentials.get()) };
    }
    if (message.type === 'ezr:translation:clear-all') {
      if (!isOptions(sender)) throw new Error('请在扩展设置页清除翻译语境。');
      service.clear();
      return { ok: true };
    }
    if (!Number.isInteger(sender.tab?.id)) throw new Error('请在阅读视图中划词翻译。');
    if (message.type === 'ezr:translation:clear') {
      service.clearFrame(slotOf(sender));
      return { ok: true };
    }
    if (!['ezr:translation:run', 'ezr:translation:learn', 'ezr:translation:vocabulary', 'ezr:translation:full'].includes(message.type)) throw new Error('未知翻译请求。');
    const url = new URL(pageUrlOf(sender));
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('当前页面不支持翻译。');
    const operation = message.type === 'ezr:translation:full' ? service.full : message.type === 'ezr:translation:learn' ? service.learn : message.type === 'ezr:translation:vocabulary' ? service.vocabulary : service.translate;
    const provider = message.type === 'ezr:translation:full' ? message.provider || config.provider : message.provider;
    const result = await operation({
      slot: slotOf(sender), documentId: sender.documentId || '', url: url.href,
      view: message.view, text: message.text, nearby: message.nearby, provider,
      translation: message.translation, sourceLanguage: message.sourceLanguage,
      texts: message.texts,
    }, config, provider === 'deepseek' ? await credentials.get() : '');
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
    if (area === 'local' && change && translationContextKey(change.oldValue) !== translationContextKey(change.newValue)) service.clear();
  });
  return service;
}
