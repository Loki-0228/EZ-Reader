/** Both settings surfaces offer only identifiers returned by the account's API. */
export function createModelPicker(select, { request, onStatus = () => {} } = {}) {
  const doc = select.ownerDocument;
  let models = [], selected = '', blocked = false, loading = false, loaded = false, revision = 0;
  let placeholder = '请先保存 API Key';
  const changed = () => { selected = select.value; onStatus(''); };
  select.addEventListener('change', changed);
  function paint() {
    const option = (value, text) => { const node = doc.createElement('option'); node.value = value; node.textContent = text; return node; };
    const empty = option('', placeholder); empty.disabled = true;
    select.replaceChildren(empty, ...models.map(model => option(model.id, model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id)));
    select.value = models.some(model => model.id === selected) ? selected : '';
    select.disabled = blocked || loading || !loaded;
  }
  return {
    update(value, disabled = false) { selected = value; blocked = disabled; paint(); },
    reset() { revision++; models = []; loaded = loading = false; placeholder = '请先保存 API Key'; onStatus(''); paint(); },
    destroy() { revision++; select.removeEventListener('change', changed); },
    async load(refresh = false) {
      const token = ++revision;
      loading = true; models = []; loaded = false; placeholder = '正在获取模型…'; paint();
      onStatus('正在获取 DeepSeek 模型列表…');
      try {
        const reply = await request({ type:'ezr:translation:models', refresh });
        if (token !== revision) return;
        if (!reply?.ok || !reply.models?.length) throw new Error(reply?.message || '模型列表为空，请刷新重试。');
        models = reply.models; loaded = true; placeholder = '请选择 API 可用模型';
        onStatus(models.some(model => model.id === selected) ? '' : '当前模型不在 API 列表中，请重新选择。');
      } catch (error) {
        if (token !== revision) return;
        placeholder = '模型列表读取失败'; onStatus(error.message);
      } finally { if (token === revision) { loading = false; paint(); } }
    },
  };
}
