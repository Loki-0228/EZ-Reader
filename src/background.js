/**
 * EZ-Reader background service worker — MV3, `"type": "module"`.
 *
 * Copied with translation/ as a private ESM dependency. Translation requests and
 * credentials are owned by the worker. Reading defaults below mirror constants.js.
 *
 * Responsibilities:
 *   1. seed `chrome.storage.local` on install (never touching existing values),
 *   2. a small, error-tolerant tab messaging layer (`send` / `broadcast`),
 *   3. the popup ⇄ content-script bridge (`ezr:relay`, `ezr:active-tab`,
 *      `ezr:ensure-content`),
 *   4. a pass-through for keyboard commands other than `_execute_action`.
 *
 * Every `chrome.*` call that can fail is guarded twice: a `try/catch` around the
 * call itself (invalidated context) and a `chrome.runtime.lastError` read inside
 * the callback (no receiver / no permission). "Receiving end does not exist" is
 * an expected outcome — the reading view is simply not mounted in that tab yet —
 * and is never logged noisily.
 */

import { registerTranslation } from './translation/background.js';
import { registerWindowToolbar } from './background/window-toolbar.js';
import { registerDocuments } from './background/documents.js';

registerTranslation();
registerDocuments();
registerWindowToolbar(chrome, { send, inject: injectContentScript });

/* ------------------------------------------------------------------ constants */

/** chrome.storage.local settings key (CONTRACTS.md §14). */
const KEY_SETTINGS_DEFAULT = 'ezr:settings:default';

/** chrome.storage.local per-origin settings key (CONTRACTS.md §14). */
const KEY_SETTINGS_BY_ORIGIN = 'ezr:settings:byOrigin';

/** Bundled content script injected on demand (same path as the manifest entry). */
const CONTENT_SCRIPT_FILES = ['content.js'];

/**
 * Default settings, inlined by value (mirror of `DEFAULT_SETTINGS` in
 * `src/core/constants.js`). Only primitive values, so a one-level copy is deep.
 * @type {Readonly<Record<string, string|number|boolean|null>>}
 */
const DEFAULT_SETTINGS = Object.freeze({
  // 排版
  fontId: 'serif-georgia',
  bodyFontSize: 16,
  lineHeight: 1.6,
  gapFactor: 1.6,
  gapExtraPx: 2,
  gapOverridePx: null,
  measure: 44,
  // 内容
  headingMode: 'standard',
  splitLines: true,
  // 大小写
  capitalizeFirst: false,
  capitalizeLocales: '',
  // 缩放
  zoomMode: 'fit-width',
  zoom: 1,
  // 外观设置
  theme: 'light',
  showOutline: false,
  toolbarDock: 'top',
  // 行为
  rememberPerSite: true,
  restorePosition: true,
});

/* -------------------------------------------------------------------- helpers */

/**
 * A plain, mutable copy of the default settings. All values are primitives, so a
 * key-by-key copy is a genuine deep copy (no shared nested objects).
 * @returns {Record<string, string|number|boolean|null>} fresh settings object
 */
function defaultSettingsCopy() {
  /** @type {Record<string, string|number|boolean|null>} */
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = DEFAULT_SETTINGS[key];
  return out;
}

/**
 * Read from `chrome.storage.local`, swallowing every failure.
 * @param {string|string[]} keys key(s) to read
 * @returns {Promise<Record<string, unknown>>} the stored bag, or `{}` on failure
 */
function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (bag) => {
        if (chrome.runtime.lastError) {
          resolve({});
          return;
        }
        resolve(bag && typeof bag === 'object' ? bag : {});
      });
    } catch {
      resolve({});
    }
  });
}

/**
 * Write to `chrome.storage.local`, swallowing every failure.
 * @param {Record<string, unknown>} items key/value pairs to persist
 * @returns {Promise<boolean>} true when the write was accepted
 */
function storageSet(items) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(items, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Seed the shared storage buckets on install. Only absent keys are written, so an
 * existing user's settings are never overwritten, and a partially seeded store is
 * completed rather than replaced.
 * @returns {Promise<void>} resolves once seeding finished (or failed silently)
 */
async function seedStorage() {
  const bag = await storageGet([KEY_SETTINGS_DEFAULT, KEY_SETTINGS_BY_ORIGIN]);
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (bag[KEY_SETTINGS_DEFAULT] === undefined || bag[KEY_SETTINGS_DEFAULT] === null) {
    patch[KEY_SETTINGS_DEFAULT] = defaultSettingsCopy();
  }
  if (bag[KEY_SETTINGS_BY_ORIGIN] === undefined || bag[KEY_SETTINGS_BY_ORIGIN] === null) {
    patch[KEY_SETTINGS_BY_ORIGIN] = {};
  }
  if (Object.keys(patch).length === 0) return;
  await storageSet(patch);
}

/**
 * `chrome.tabs.query` with an error-tolerant callback wrapper.
 * @param {chrome.tabs.QueryInfo} query query object
 * @returns {Promise<chrome.tabs.Tab[]>} matching tabs, or `[]` on failure
 */
function queryTabs(query) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query(query, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(Array.isArray(tabs) ? tabs.filter(Boolean) : []);
      });
    } catch {
      resolve([]);
    }
  });
}

/* ------------------------------------------------------------------ messaging */

/**
 * Send one message to the top frame of a tab.
 *
 * Resolves `null` — never rejects — when the tab does not exist, has no content
 * script, or the extension context is gone; all three are normal states for this
 * extension ("Reading end does not exist" happens on every page where the reader
 * was never opened).
 *
 * @param {number} tabId target tab id
 * @param {unknown} message message payload (`{ type: 'ezr:…' }`)
 * @returns {Promise<unknown|null>} the receiver's reply, or `null` when there is none
 */
function send(tabId, message) {
  return new Promise((resolve) => {
    if (typeof tabId !== 'number' || !Number.isFinite(tabId) || tabId < 0) {
      resolve(null);
      return;
    }
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response === undefined ? null : response);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Send one message to every frame of a tab (no `frameId` option ⇒ all frames).
 * Only the first reply is meaningful to callers; the rest are acknowledgements.
 * @param {number} tabId target tab id
 * @param {unknown} message message payload
 * @returns {Promise<unknown|null>} the first reply received, or `null`
 */
function sendEveryFrame(tabId, message) {
  return new Promise((resolve) => {
    if (typeof tabId !== 'number' || !Number.isFinite(tabId) || tabId < 0) {
      resolve(null);
      return;
    }
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response === undefined ? null : response);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Broadcast a message, trying the top frame first (`{ frameId: 0 }`) and falling
 * back to a frame-less send so iframes receive it too. Exists because the content
 * script is injected with `all_frames: true`: the top frame owns the reader, but
 * iframes still need lifecycle messages (`ezr:close`, …).
 *
 * Every failure mode is swallowed; the resolved array only reports what answered.
 *
 * @param {unknown} message message payload
 * @param {number} [tabId] single target tab; omit to broadcast to every tab
 * @returns {Promise<Array<{tabId: number, reply: unknown|null}>>} per-tab replies
 */
async function broadcast(message, tabId) {
  /** @type {chrome.tabs.Tab[]} */
  let targets = [];
  if (typeof tabId === 'number' && Number.isFinite(tabId)) {
    targets = [{ id: tabId }];
  } else {
    targets = await queryTabs({});
  }

  /** @type {Array<{tabId: number, reply: unknown|null}>} */
  const results = [];
  for (const tab of targets) {
    const id = tab && typeof tab.id === 'number' ? tab.id : -1;
    if (id < 0) continue;
    let reply = await send(id, message);
    if (reply === null) reply = await sendEveryFrame(id, message);
    results.push({ tabId: id, reply });
  }
  return results;
}

/**
 * Inject the bundled content script into every frame of a tab, on demand.
 *
 * Safe to call when the script is already present: the bundle sets
 * `globalThis.__EZR_CONTENT_LOADED__` and returns immediately on a second run, so
 * a re-injection is a no-op. Failure (chrome:// pages, the Web Store, PDF viewer)
 * is expected and reported, not thrown.
 *
 * @param {number} tabId target tab id
 * @returns {Promise<{ok: true} | {ok: false, reason: string, message: string}>} outcome
 */
function injectContentScript(tabId) {
  return new Promise((resolve) => {
    if (typeof tabId !== 'number' || !Number.isFinite(tabId) || tabId < 0) {
      resolve({ ok: false, reason: 'injection-failed', message: 'invalid tab id' });
      return;
    }
    try {
      chrome.scripting.executeScript(
        { target: { tabId, allFrames: true }, files: CONTENT_SCRIPT_FILES },
        () => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, reason: 'injection-failed', message: String(error.message || error) });
            return;
          }
          resolve({ ok: true });
        },
      );
    } catch (error) {
      resolve({
        ok: false,
        reason: 'injection-failed',
        message: String((error && error.message) || error),
      });
    }
  });
}

/**
 * Answer one `ezr:*` message from an extension page (the popup).
 * @param {string} type message type
 * @param {Record<string, unknown>} message full message
 * @returns {Promise<unknown>} the reply payload
 */
async function handleMessage(type, message) {
  switch (type) {
    case 'ezr:relay': {
      const payload = message.message;
      if (!payload || typeof payload !== 'object') return { ok: false, reason: 'unknown-message' };
      const tabId = typeof message.tabId === 'number' ? message.tabId : -1;
      const reply = await send(tabId, payload);
      return reply === null ? { ok: false, reason: 'no-receiver' } : reply;
    }
    case 'ezr:active-tab': {
      const tabs = await queryTabs({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || typeof tab.id !== 'number') return { ok: false, reason: 'no-active-tab' };
      return {
        ok: true,
        tabId: tab.id,
        url: typeof tab.url === 'string' ? tab.url : '',
        title: typeof tab.title === 'string' ? tab.title : '',
      };
    }
    case 'ezr:ensure-content': {
      const tabId = typeof message.tabId === 'number' ? message.tabId : -1;
      // The bundle registers its `onMessage` listener synchronously while it is
      // being evaluated, so the tab is addressable as soon as this resolves.
      return injectContentScript(tabId);
    }
    default:
      return { ok: false, reason: 'unknown-message' };
  }
}

/* ------------------------------------------------------------------ listeners */

try {
  chrome.runtime.onInstalled.addListener(() => {
    void seedStorage();
  });
} catch {
  /* 无法注册时后台其余能力仍然可用 */
}

try {
  // Storage may have been cleared by the user or by another profile action; a
  // startup re-seed only ever fills in missing keys.
  chrome.runtime.onStartup.addListener(() => {
    void seedStorage();
  });
} catch {
  /* 可选监听器 */
}

try {
  chrome.commands.onCommand.addListener((command, tab) => {
    // `_execute_action` is handled by Chrome itself: it opens the popup declared
    // in the manifest, so there is nothing to do here.
    if (command === '_execute_action') return;
    void (async () => {
      const direct = tab && typeof tab.id === 'number' ? tab.id : -1;
      if (direct >= 0) {
        await broadcast({ type: 'ezr:toggle' }, direct);
        return;
      }
      const active = await queryTabs({ active: true, currentWindow: true });
      const fallback = active[0];
      if (fallback && typeof fallback.id === 'number') {
        await broadcast({ type: 'ezr:toggle' }, fallback.id);
      }
    })();
  });
} catch {
  /* 命令注册失败不影响消息桥 */
}

/**
 * The only inbound channel: messages from the popup / options page (their
 * `sender` carries no `tab`). `true` is returned exclusively for our own `ezr:*`
 * namespace and only because the reply is always produced asynchronously;
 * anything else returns `undefined` so foreign channels stay untouched.
 */
try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message && typeof message === 'object' ? message.type : undefined;
    if (typeof type !== 'string' || !type.startsWith('ezr:')) return undefined;
    if (type.startsWith('ezr:translation:')) return undefined;
    if (type.startsWith('ezr:documents:')) return undefined;
    if (type.startsWith('ezr:window-toolbar:')) return undefined;

    handleMessage(type, message)
      .then((reply) => {
        sendResponse(reply);
      })
      .catch((error) => {
        sendResponse({ ok: false, reason: 'error', message: String((error && error.message) || error) });
      });

    return true; // 异步回复
  });
} catch (error) {
  // 注册失败意味着 popup 无法驱动标签页，属于必须暴露的致命错误。
  console.error('[EZ-Reader] 无法注册 runtime.onMessage 监听器', error);
}
