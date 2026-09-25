/** Toolbar visibility belongs to a browser window, survives worker sleep, and expires with the window. */
export function registerWindowToolbar(api = chrome, { send, inject } = {}) {
  const prefix = 'ezr:toolbar:window:';
  const queues = new Map();
  const keyOf = id => prefix + id;
  const enqueue = (id, work) => {
    const job = (queues.get(id) || Promise.resolve()).then(work);
    queues.set(id, job.catch(() => {}));
    return job;
  };
  const read = async id => {
    const state = (await api.storage.session.get(keyOf(id)))[keyOf(id)];
    return { configured: !!state, enabled: !!state?.enabled, revision: state?.revision || 0, windowId: id };
  };
  async function deliver(tab, state, allowInject = false) {
    if (!state.configured || !Number.isInteger(tab.id) || tab.windowId !== state.windowId) return null;
    if (tab.url && !/^(https?|file):/.test(tab.url)) return null;
    const message = { type: 'ezr:toolbar-state', ...state };
    void api.tabs.sendMessage(tab.id, { ...state, type:'ezr:frame-toolbar-state' }).catch(() => {});
    let reply = await send(tab.id, message);
    if (reply === null && state.enabled && allowInject) {
      const injected = await inject(tab.id);
      if (injected?.ok) reply = await send(tab.id, message);
    }
    return reply;
  }
  async function target(message, sender) {
    if (sender.id !== api.runtime.id) throw new Error('不允许此来源操作工具栏。');
    if (sender.tab) {
      if (sender.frameId && message.type !== 'ezr:window-toolbar:get') throw new Error('仅网页主框架可操作工具栏。');
      return api.tabs.get(sender.tab.id);
    }
    if (!sender.url?.startsWith(api.runtime.getURL('pages/'))) throw new Error('请从扩展面板打开工具栏。');
    if (!Number.isInteger(message.tabId)) throw new Error('未找到当前标签页。');
    return api.tabs.get(message.tabId);
  }
  async function handle(message, sender) {
    const tab = await target(message, sender);
    return enqueue(tab.windowId, async () => {
      const previous = await read(tab.windowId);
      if (message.type === 'ezr:window-toolbar:get') return { ok: true, ...previous };
      const state = { enabled: message.enabled === true, revision: previous.revision + 1 };
      await api.storage.session.set({ [keyOf(tab.windowId)]: state });
      const value = { configured: true, windowId: tab.windowId, ...state };
      const tabs = await api.tabs.query({ windowId: tab.windowId });
      const replies = await Promise.all(tabs.map(item => deliver(item, value, item.id === tab.id)));
      const reply = replies[tabs.findIndex(item => item.id === tab.id)];
      return { ok: true, ...value, available: !!reply?.ok };
    });
  }
  const sync = async (tabId, moved = false) => {
    const tab = await api.tabs.get(tabId);
    return enqueue(tab.windowId, async () => {
      const current = await api.tabs.get(tabId);
      if (current.windowId !== tab.windowId) return;
      const state = await read(tab.windowId);
      await deliver(current, moved ? { ...state, configured: true } : state);
    });
  };
  const quietly = job => { void job.catch(() => {}); };
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['ezr:window-toolbar:get', 'ezr:window-toolbar:set'].includes(message?.type)) return;
    handle(message, sender).then(respond).catch(error => respond({ ok: false, message: error.message }));
    return true;
  });
  api.tabs.onActivated.addListener(({ tabId }) => quietly(sync(tabId)));
  api.tabs.onUpdated.addListener((tabId, change) => { if (change.url || change.status === 'complete') quietly(sync(tabId)); });
  api.tabs.onAttached.addListener(tabId => quietly(sync(tabId, true)));
  api.windows.onRemoved.addListener(windowId => quietly(enqueue(windowId, async () => {
    await api.storage.session.remove(keyOf(windowId));
    queues.delete(windowId);
  })));
  return { handle, sync };
}
