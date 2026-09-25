/** Read exactly the user's selection; ranges locate it, never reconstruct its text. */
const INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel']);
function parent(node) { return node?.parentNode || node?.host || null; }
function contains(root, node) {
  if (!root) return true;
  for (let current = node; current; current = parent(current)) if (current === root) return true;
  return false;
}
function allowed(node, root, exclude) {
  return !!node && contains(root, node) && (!exclude || !contains(exclude, node));
}
function rectangle(range, node, doc) {
  let rect;
  try { rect = range?.getBoundingClientRect(); } catch { /* Text is still usable. */ }
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!rect?.width && !rect?.height) {
    try { rect = element?.getBoundingClientRect(); } catch { /* Fall back to viewport. */ }
  }
  const left = Number.isFinite(rect?.left) ? rect.left : 10;
  const top = Number.isFinite(rect?.top) ? rect.top : 10;
  const width = Math.max(0, Number(rect?.width) || 0);
  const height = Math.max(0, Number(rect?.height) || 0);
  return { left, top, right:left + width, bottom:top + height, width, height };
}
function nearbyText(node, text) {
  // Only a short local text block provides context; never scan the page or form values.
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const local = element?.closest?.('p,li,td,th,blockquote,pre,h1,h2,h3,h4,h5,h6');
  const value = local?.textContent;
  if (!value || value.length > 6000) return text.slice(0, 1500);
  const index = value.indexOf(text);
  const start = Math.max(0, index - 350);
  return value.slice(start, start + 1500).trim();
}
function snapshot(selection, doc, root, exclude) {
  if (!selection || selection.isCollapsed) return null;
  const anchorNode = selection.anchorNode, focusNode = selection.focusNode;
  if (!allowed(anchorNode, root, exclude) || !allowed(focusNode, root, exclude)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  let range = null;
  try {
    const candidate = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (candidate && allowed(candidate.startContainer, root, exclude) && allowed(candidate.endContainer, root, exclude)) range = candidate.cloneRange();
  } catch { /* Some viewers supply selected text without an accessible Range. */ }
  return { text, range, rect:rectangle(range, anchorNode, doc), anchorNode, focusNode, nearby:nearbyText(anchorNode, text), kind:'selection' };
}
function read(doc, root, exclude, depth) {
  if (!doc || depth > 4) return null;
  let active = doc.activeElement;
  const scopes = [];
  while (active?.shadowRoot) {
    scopes.unshift(active.shadowRoot);
    const inner = active.shadowRoot.activeElement;
    if (!inner || inner === active) break;
    active = inner;
  }
  // A focused control owns the selection; do not reuse a stale selection behind it.
  if (active?.matches?.('input,textarea')) {
    if (!allowed(active, root, exclude)) return null;
    if (active.localName === 'input' && !INPUT_TYPES.has(active.type)) return null;
    const start = active.selectionStart, end = active.selectionEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
    const text = active.value.slice(start, end).trim();
    if (!text) return null;
    return { text, range:null, rect:rectangle(null, active, doc), anchorNode:active, focusNode:active,
      nearby:text.slice(0, 1500), kind:'input', start, end };
  }
  if (active?.matches?.('iframe,frame') && allowed(active, root, exclude)) {
    try {
      const result = read(active.contentDocument, null, null, depth + 1);
      if (result) {
        const bounds = active.getBoundingClientRect();
        const scaleX = active.offsetWidth ? bounds.width / active.offsetWidth : 1;
        const scaleY = active.offsetHeight ? bounds.height / active.offsetHeight : 1;
        const left = bounds.left + active.clientLeft * scaleX;
        const top = bounds.top + active.clientTop * scaleY;
        const rect = result.rect;
        result.rect = { left:left + rect.left * scaleX, right:left + rect.right * scaleX,
          top:top + rect.top * scaleY, bottom:top + rect.bottom * scaleY,
          width:rect.width * scaleX, height:rect.height * scaleY };
        return result;
      }
    } catch { /* Cross-origin frames are handled by their own content scripts. */ }
    return null;
  }
  const scopedRoot = root?.getRootNode?.();
  if (scopedRoot && scopedRoot !== doc) scopes.unshift(scopedRoot);
  scopes.push(doc);
  for (const scope of new Set(scopes)) {
    try {
      const result = snapshot(scope.getSelection?.(), doc, root, exclude);
      if (result) return result;
    } catch { /* A viewer may disallow selection access. */ }
  }
  return null;
}
/** Returns null or {text, range|null, rect, anchorNode, focusNode, nearby, kind}. */
export function readUserSelection({ doc = globalThis.document, root = null, exclude = null } = {}) {
  try { return read(doc, root, exclude, 0); } catch { return null; }
}
