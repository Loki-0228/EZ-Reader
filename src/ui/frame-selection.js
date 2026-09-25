import { createTranslation } from './translation.js';
import { readerCss } from '../core/styles.js';
import { applyVars } from './mount.js';
import { normalizeSettings } from '../core/settings.js';

/** Frames keep their own selected text and result, including cross-origin viewers. */
export function createFrameSelection(doc) {
  let host = null, translation = null, enabled = false, lastRevision = -1, lastWindow = null;
  function setEnabled(value, revision, windowId) {
    if (Number.isInteger(revision)) {
      if (windowId !== lastWindow) { lastWindow = windowId; lastRevision = -1; }
      if (revision < lastRevision) return;
      lastRevision = revision;
    }
    enabled = value === true;
    if (!enabled) {
      translation?.destroy(); translation = null;
      host?.remove(); host = null;
      return;
    }
    if (translation) return;
    host = doc.createElement('div');
    host.id = 'ezr-frame-tools';
    host.setAttribute('data-ezr-ui', '');
    const shadow = host.attachShadow({ mode:'open' });
    const style = doc.createElement('style');
    style.textContent = readerCss() + '\n:host { pointer-events:none!important; } .ezr-root { height:0; overflow:visible; background:transparent; } .ezr-translation { pointer-events:auto; max-height:calc(100vh - 20px); overflow:auto; }';
    const root = doc.createElement('div');
    root.className = 'ezr-root';
    applyVars(root, normalizeSettings());
    shadow.append(style, root);
    doc.documentElement.append(host);
    translation = createTranslation({
      root, article:doc.documentElement, doc, mode:'original', isActive:()=>enabled,
      getDocument:()=>({ title:doc.title, blocks:[] }),
    });
  }
  async function sync() {
    try {
      const state = await chrome.runtime.sendMessage({ type:'ezr:window-toolbar:get' });
      if (state?.ok) setEnabled(state.enabled, state.revision, state.windowId);
    } catch { /* The page can outlive an extension reload. */ }
  }
  void sync();
  doc.defaultView.addEventListener('pagehide', () => setEnabled(false));
  doc.defaultView.addEventListener('pageshow', () => { void sync(); });
  return { setEnabled };
}
