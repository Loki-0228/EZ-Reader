import { isModelId } from './config.js';

/** Fetch metadata in the worker; credentials never enter the model picker. */
export function createModelStore({ fetchFn = fetch, now = Date.now } = {}) {
  let cached = null;
  return {
    clear() { cached = null; },
    async load(apiKey, refresh = false) {
      if (!apiKey) throw new Error('请先在扩展设置页保存 DeepSeek API Key。');
      if (!refresh && cached?.key === apiKey && cached.expires > now()) return cached.job;
      const entry = { key:apiKey, expires:now() + 5 * 60 * 1000 };
      const job = (async () => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
        try {
          const response = await fetchFn('https://api.deepseek.com/models', { headers:{ Authorization:`Bearer ${apiKey}` },
            signal:controller.signal, credentials:'omit', referrerPolicy:'no-referrer' });
          if (!response.ok) throw new Error(response.status === 401 ? 'DeepSeek API Key 无效，请检查密钥。' : `模型列表读取失败（HTTP ${response.status}），请重试。`);
          const data = await response.json(), seen = new Set();
          const models = (Array.isArray(data?.data) ? data.data : []).slice(0, 100).flatMap(item => {
            if (!isModelId(item?.id) || seen.has(item.id)) return [];
            seen.add(item.id);
            return [{ id:item.id, name:typeof item.name === 'string' ? item.name.trim().slice(0, 160) : item.id }];
          });
          if (!models.length) throw new Error('DeepSeek API 未返回可用模型，请刷新重试。');
          return models;
        } catch (error) {
          if (controller.signal.aborted) throw new Error('读取 DeepSeek 模型列表超时，请重试。');
          if (error instanceof TypeError) throw new Error('无法连接 DeepSeek 模型接口，请检查网络后重试。');
          throw error;
        } finally { clearTimeout(timer); }
      })();
      entry.job = job; cached = entry;
      try { return await job; }
      catch (error) { if (cached === entry) cached = null; throw error; }
    },
  };
}
