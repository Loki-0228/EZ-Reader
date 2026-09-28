const SKIP = 'script,style,noscript,template,textarea,input,select,button,code,pre,kbd,samp,svg,math,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[hidden],[aria-hidden="true"],#ezr-root,#ezr-full-host,[data-ezr-pick-overlay],.ezr-full-target';
const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,td,th,figcaption,blockquote,dt,dd,div,section,article,main,body';
const canonical = text => text.replace(/\s+/gu, ' ').trim();

/** Keep formatting boundaries as independent text runs. No word correspondence is inferred. */
export function collectTranslationGroups(root, doc = root.ownerDocument) {
  const groups = [], current = new Map(), walker = doc.createTreeWalker(root, 5);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) {
      if (node.tagName === 'BR') current.delete(node.parentElement.closest(BLOCK) || root);
      continue;
    }
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP) || !node.data || !parent.getClientRects().length) continue;
    const style = doc.defaultView.getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
    const block = parent.closest(BLOCK) || root;
    if (!root.contains(block) && block !== root) continue;
    let group = current.get(block);
    if (!group) { group = { block, nodes: [], runs: [], raw: '', target: null }; current.set(block, group); groups.push(group); }
    let owner = parent;
    while (owner.hasAttribute('data-ezr-w')) owner = owner.parentElement;
    let run = group.runs.at(-1);
    if (!run || run.owner !== owner) { run = { owner, nodes: [], raw: '', inserted: null }; group.runs.push(run); }
    const record = { node, original: node.data };
    run.nodes.push(record); run.raw += node.data; group.nodes.push(record); group.raw += node.data;
  }
  return groups.flatMap(group => {
    group.source = canonical(group.raw);
    if (!/\p{L}/u.test(group.source)) return [];
    for (const run of group.runs) {
      run.source = canonical(run.raw);
      run.chunks = /\p{L}/u.test(run.source) ? splitTranslationText(run.source) : [];
      run.prefix = run.raw.match(/^\s*/u)[0]; run.suffix = run.raw.match(/\s*$/u)[0];
    }
    group.chunks = group.runs.flatMap(run => run.chunks);
    return [group];
  });
}

export function splitTranslationText(text, limit = 1000) {
  const chunks = []; let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const section = text.slice(start, end);
      const last = [...section.matchAll(/[.!?。！？]\s*|\s+/gu)].findLast(match => match.index > limit / 2);
      if (last) end = start + last.index + last[0].length;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}

export function joinTranslations(results) {
  return results.map((result, index) => result.text + (index < results.length - 1 && /\s$/u.test(result.source)
    && !/^(zh|ja)/i.test(result.target) && !/\s$/u.test(result.text) ? ' ' : '')).join('');
}

export function restoreTranslationGroups(groups) {
  for (const group of groups) {
    group.appliedResults = null;
    group.target?.remove(); group.target = null;
    for (const run of group.runs) { run.inserted?.remove(); run.inserted = null; }
    for (const item of group.nodes) {
      if (item.rendered !== undefined && item.node.data === item.rendered) item.node.data = item.original;
      item.rendered = undefined;
    }
  }
}

export function applyTranslationGroup(group, results, bilingual = false) {
  if (!group.block.isConnected || group.nodes.some(item => !item.node.isConnected || item.node.data !== (item.rendered ?? item.original))) return false;
  restoreTranslationGroups([group]); group.language = results[0]?.target;
  let offset = 0;
  const texts = group.runs.map(run => {
    if (!run.chunks.length) return run.raw;
    const translated = joinTranslations(results.slice(offset, offset + run.chunks.length)); offset += run.chunks.length;
    return run.prefix + translated + run.suffix;
  });
  if (bilingual) {
    const target = group.block.ownerDocument.createElement('span');
    target.className = 'ezr-full-target'; target.lang = group.language; target.textContent = texts.join('');
    group.block.appendChild(target); group.target = target; return true;
  }
  group.runs.forEach((run, index) => {
    if (!run.chunks.length) return;
    // Capitalization wrappers must not turn the whole translation into one unwrappable word.
    const first = run.nodes[0].node;
    if (first.parentElement.hasAttribute('data-ezr-w')) {
      run.inserted = first.ownerDocument.createTextNode(texts[index]);
      run.owner.insertBefore(run.inserted, first.parentElement);
    }
    run.nodes.forEach((item, position) => { item.rendered = !position && !run.inserted ? texts[index] : ''; item.node.data = item.rendered; });
  });
  return true;
}

/** Reject any selection touching generated translation, including mixed/cross-paragraph ranges. */
export function isTranslatedSelection(range, groups) {
  for (const group of groups) {
    const target = group.target;
    if (target?.isConnected && range.intersectsNode(target)) return true;
    for (const run of group.runs) {
      if (run.inserted?.isConnected && range.intersectsNode(run.inserted)) return true;
      if (run.nodes.some(item => item.rendered && item.node.isConnected && item.node.data === item.rendered && range.intersectsNode(item.node))) return true;
    }
  }
  return false;
}
