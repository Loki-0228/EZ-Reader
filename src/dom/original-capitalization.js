const PROTECTED = 'input,textarea,select,button,code,pre,kbd,samp,svg,math,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[hidden],[aria-hidden="true"],#ezr-root,[data-ezr-pick-overlay],[data-ezr-toast]';
const SKIP = 'head,script,style,noscript,template,' + PROTECTED;

/** Style source text in place; never replace nodes, rewrite text, or change event targets. */
export function createOriginalCapitalization(doc) {
  let enabled = false, timer = 0, observer = null;
  const changes = new Map();
  function restore() {
    for (const [element, saved] of changes) {
      if (element.getAttribute('style') === saved.appliedStyle) {
        if (saved.style === null) element.removeAttribute('style');
        else element.setAttribute('style', saved.style);
      } else if (element.style.getPropertyValue('text-transform') === saved.appliedValue
        && element.style.getPropertyPriority('text-transform') === 'important') {
        // Preserve unrelated styles or text the website changed while the feature was on.
        if (saved.value) element.style.setProperty('text-transform', saved.value, saved.priority);
        else element.style.removeProperty('text-transform');
        if (saved.style === null && !element.style.length) element.removeAttribute('style');
      }
    }
    changes.clear();
  }
  function apply(element, value) {
    const saved = { style: element.getAttribute('style'), value: element.style.getPropertyValue('text-transform'),
      priority: element.style.getPropertyPriority('text-transform'), appliedValue: value };
    element.style.setProperty('text-transform', value, 'important');
    saved.appliedStyle = element.getAttribute('style'); changes.set(element, saved);
  }
  function refresh() {
    timer = 0;
    if (!enabled || !doc.body) return;
    observer?.disconnect(); restore();
    const targets = new Set(), walker = doc.createTreeWalker(doc.body, 4);
    let text;
    while ((text = walker.nextNode())) {
      const parent = text.parentElement;
      if (!/[a-z]/i.test(text.data) || !parent || targets.has(parent) || parent.closest(SKIP) || !parent.getClientRects().length) continue;
      const style = doc.defaultView.getComputedStyle(parent);
      if (style.visibility !== 'hidden' && style.visibility !== 'collapse') targets.add(parent);
    }
    const guards = [];
    for (const element of doc.body.querySelectorAll(PROTECTED)) {
      let parent = element.parentElement;
      while (parent && !targets.has(parent)) parent = parent.parentElement;
      if (parent) guards.push([element, doc.defaultView.getComputedStyle(element).textTransform]);
    }
    for (const element of targets) apply(element, 'capitalize');
    for (const [element, value] of guards) apply(element, value);
    observer?.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['contenteditable', 'translate', 'class', 'hidden', 'aria-hidden'] });
  }
  return {
    setEnabled(value) {
      value = !!value;
      if (enabled === value) return;
      enabled = value; clearTimeout(timer); timer = 0;
      if (!enabled) { observer?.disconnect(); restore(); return; }
      if (!observer) observer = new doc.defaultView.MutationObserver(records => {
        if (!enabled || timer || !records.some(record => !record.target.closest?.(SKIP))) return;
        // Batch new content. Character-data translation writes need no restyling.
        timer = setTimeout(refresh, 80);
      });
      refresh();
    },
  };
}
