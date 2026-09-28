import { findTextBox, fitText, layoutManual } from './layout.js';
import { createPdfEditor } from './pdf-edit.js';

const FONT = "'Segoe UI','Microsoft YaHei','Noto Sans',sans-serif";
const canonical = text => text.replace(/\s+/gu,' ').trim();
const key = (page,box) => page + ':' + box.id;
export const PDF_TRANSLATION_CSS = `
.ezr-pdf-overlay{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:visible}
.ezr-pdf-surface{position:absolute;left:0;top:0;transform-origin:0 0}
.ezr-pdf-surface canvas,.ezr-pdf-surface img{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ezr-pdf-text{position:absolute;box-sizing:content-box;margin:0;padding:0;border:0;transform-origin:0 0;white-space:pre;overflow:visible;pointer-events:auto;font-family:${FONT};text-align:start;text-transform:none;font-kerning:normal}
.ezr-pdf-text span{display:block;white-space:pre;position:relative}
.ezr-pdf-translated .textLayer{visibility:hidden}
.ezr-pdf-editing{cursor:crosshair;user-select:none;touch-action:none}
.ezr-pdf-editing .ezr-pdf-text{cursor:pointer;outline:1px dashed var(--accent,#3c73cb);outline-offset:2px;user-select:none}
.ezr-pdf-editing .ezr-pdf-text-selected{outline:2px solid var(--accent,#3c73cb);background:color-mix(in srgb,var(--accent,#3c73cb) 14%,transparent)}
.ezr-pdf-editing .ezr-pdf-text:focus-visible{outline:3px solid var(--accent,#3c73cb)}
.ezr-pdf-edit-layer{position:absolute;inset:0;z-index:4;pointer-events:none;display:none}
.ezr-pdf-editing .ezr-pdf-edit-layer{display:block}
.ezr-pdf-edit-surface{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none}
.ezr-pdf-edit-box{position:absolute;box-sizing:content-box;transform-origin:0 0;pointer-events:auto;cursor:pointer;outline:1px dashed var(--accent,#3c73cb);outline-offset:2px}
.ezr-pdf-edit-box[data-original=true]{outline-color:#946000;outline-style:solid}
.ezr-pdf-edit-box[data-original=true]:is(:hover,:focus-visible,.ezr-pdf-edit-selected)::after{content:'原文';position:absolute;right:0;top:0;transform:translateY(-100%);padding:calc(1px / var(--ezr-pdf-box-scale,1)) calc(4px / var(--ezr-pdf-box-scale,1));background:#fff4cf;color:#704700;font:calc(11px / var(--ezr-pdf-box-scale,1))/1.4 'Segoe UI','Microsoft YaHei',sans-serif;white-space:nowrap;pointer-events:none}
.ezr-pdf-edit-box.ezr-pdf-edit-selected{outline:2px solid var(--accent,#3c73cb);background:color-mix(in srgb,var(--accent,#3c73cb) 14%,transparent)}
.ezr-pdf-edit-box:focus-visible{outline:3px solid var(--accent,#3c73cb)}
.ezr-pdf-marquee{position:fixed;z-index:5;pointer-events:none;border:1px solid var(--accent,#3c73cb);background:color-mix(in srgb,var(--accent,#3c73cb) 14%,transparent)}
`;

/** Keep PDF graphics in place and replace only completed text boxes. */
export function createPdfTranslation({ viewer, eventBus, container, getPdf, prepare, onError, onChange, onEditChange }) {
  let parsed = null, groups = [], values = new Map(), revision = 0, generation = 0, timer = 0, busy = false;
  const painted = new WeakMap(), renders = new Set(), fontSizes = new Map();
  const alignments = new Map(), textModels = new WeakMap(), originals = new Set();
  let viewAvailable = false;
  let measureContext;
  const failedPages = new Map(), listeners = new Set();
  let retrying = false, editActive = false;
  const notify = () => { for (const listener of listeners) listener(); };
  const editor = createPdfEditor({ container, onChange:state => {
    const editable = state.selected.filter(id => values.has(id) && !originals.has(id));
    const elements = [...container.querySelectorAll('.ezr-pdf-text')].filter(node => state.selected.includes(node.dataset.box));
    const sizes = editable.map(id => fontSizes.get(id) ?? Number(elements.find(node => node.dataset.box === id)?.dataset.fontSize)).filter(Number.isFinite);
    const mixed = sizes.some(size => Math.abs(size - sizes[0]) > .01);
    const alignment = axis => {
      const fallback = axis === 'horizontal' ? 'left' : 'top';
      const choices = editable.map(id => alignments.get(id)?.[axis] || fallback);
      return choices.some(value => value !== choices[0]) ? '' : choices[0] || fallback;
    };
    onEditChange?.({ ...state, editable:editable.length, originalSelected:state.selected.filter(id => originals.has(id)).length,
      originalCount:originals.size, fontSize:mixed ? null : sizes[0] ?? null, mixed,
      horizontal:alignment('horizontal'), vertical:alignment('vertical'),
      overflow:elements.filter(node => node.dataset.overflow === 'true').length });
    if (editActive !== state.active) { editActive = state.active; notify(); }
  } });
  const style = document.createElement('style'); style.textContent = PDF_TRANSLATION_CSS; document.head.appendChild(style);

  async function prepareGroups() {
    const token = generation;
    const result = await prepare();
    if (token !== generation) throw new Error('PDF 已切换，请重新选择。');
    if (parsed !== result) {
      parsed = result;
      groups = parsed.pages.flatMap(page => page.boxes.filter(box => /\p{L}/u.test(box.text))
        .map(box => ({ id:key(page.number,box), page:page.number, source:canonical(box.text) })));
      publish();
    }
    syncEditLayers(); editor.setAvailable(viewAvailable && !!getPdf());
    return groups;
  }
  const effectiveValues = () => new Map([...values].filter(([id]) => !originals.has(id)));
  const publish = () => { onChange?.(effectiveValues().size,parsed?.pages.reduce((total,page) => total + page.boxes.length,0) || 0,originals.size); notify(); };
  function syncEditLayers() {
    if (!parsed) return;
    for (const page of parsed.pages) {
      const view = viewer.getPageView(page.number - 1);
      if (!view?.div || view.renderingState !== 3) continue;
      let layer = view.div.querySelector('.ezr-pdf-edit-layer');
      if (!layer) {
        layer = document.createElement('div'); layer.className = 'ezr-pdf-edit-layer';
        const surface = document.createElement('div'); surface.className = 'ezr-pdf-edit-surface';
        for (const box of page.boxes) {
          const element = document.createElement('div'); element.className = 'ezr-pdf-edit-box';
          element.dataset.box = key(page.number,box); element.dataset.fullText = box.text;
          Object.assign(element.style,{ left:box.left + 'px',top:box.top + 'px',width:box.width + 'px',height:box.height + 'px',transform:'rotate(' + box.angle + 'rad)' });
          surface.appendChild(element);
        }
        layer.appendChild(surface); view.div.appendChild(layer);
      }
      const scale = view.viewport.width / page.width;
      layer.firstChild.style.transform = 'scale(' + scale + ')';
      layer.firstChild.style.setProperty('--ezr-pdf-box-scale',String(scale));
      for (const element of layer.querySelectorAll('.ezr-pdf-edit-box')) element.dataset.original = String(originals.has(element.dataset.box));
    }
    editor.refresh();
  }
  function clearLayers() {
    container.querySelectorAll('.ezr-pdf-overlay').forEach(layer => layer.remove());
    container.querySelectorAll('.ezr-pdf-translated').forEach(page => page.classList.remove('ezr-pdf-translated'));
  }
  function restore() {
    editor.setActive(false); revision++; values = new Map(); failedPages.clear();
    clearLayers(); syncEditLayers(); publish();
  }
  function reset() {
    generation++; parsed = null; groups = []; fontSizes.clear(); alignments.clear(); originals.clear(); restore();
    container.querySelectorAll('.ezr-pdf-edit-layer').forEach(layer => layer.remove()); editor.setAvailable(false);
    for (const task of renders) task.cancel();
  }
  function apply(entries) {
    const next = new Map(entries.map(entry => [entry.id,entry.text]));
    if (next.size === values.size && [...next].every(([id,text]) => values.get(id) === text)) return;
    values = next; revision++; publish(); schedule();
  }
  function layoutElement(element, box, text, weight, size, alignment = {}) {
    measureContext ||= document.createElement('canvas').getContext('2d');
    const measureAtSize = (value,fontSize) => {
      measureContext.font = weight + ' ' + fontSize + 'px ' + FONT;
      const metrics = measureContext.measureText(value);
      return { width:Math.max(metrics.width,metrics.actualBoundingBoxRight + Math.max(0,metrics.actualBoundingBoxLeft)) + fontSize * .02,
        height:metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent };
    };
    const layout = size === undefined ? fitText(text,box,measureAtSize) : layoutManual(text,box,size,measureAtSize);
    const horizontal = alignment.horizontal || 'left', vertical = alignment.vertical || 'top';
    const offset = (box.height - layout.height) * (vertical === 'bottom' ? 1 : vertical === 'middle' ? .5 : 0);
    element.dataset.overflow = String(!layout.fits); element.dataset.fontSize = layout.fontSize;
    element.dataset.horizontal = horizontal; element.dataset.vertical = vertical;
    element.style.fontSize = layout.fontSize + 'px'; element.style.lineHeight = String(layout.lineHeight);
    element.style.textAlign = horizontal;
    element.replaceChildren();
    for (const line of layout.lines) {
      const span = document.createElement('span'); span.textContent = line || '\u200b'; span.style.top = offset + 'px'; element.appendChild(span);
    }
  }
  async function renderPage(pageModel, snapshot, scale = 2, fontSnapshot = new Map(fontSizes), intent = 'display', alignmentSnapshot = new Map(alignments)) {
    const token = generation, pdf = getPdf();
    if (!pdf) throw new Error('PDF 尚未打开。');
    const page = await pdf.getPage(pageModel.number);
    if (token !== generation) throw new Error('PDF 已切换，请重试。');
    const renderScale = Math.min(scale, Math.sqrt(8_388_608 / (pageModel.width * pageModel.height)));
    const viewport = page.getViewport({ scale:renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d'), matched = new Set(), colors = new Map(), weights = new Map();
    const targets = pageModel.boxes.filter(box => snapshot.has(key(pageModel.number,box)));
    // Print intent keeps the operator-list loop on microtasks; display intent would stall
    // inside requestAnimationFrame once the export window takes focus away from this page.
    const task = page.render({ canvasContext:context, viewport, annotationMode:0, intent,
      textFilter(info) {
        if (!info.text.trim()) return true;
        const box = findTextBox(pageModel.boxes,info.x / renderScale,info.y / renderScale);
        if (!box || !snapshot.has(key(pageModel.number,box))) return true;
        matched.add(box.id);
        if (!colors.has(box.id) && typeof info.color === 'string') colors.set(box.id,info.color);
        if (/bold|black|heavy/i.test(info.fontName || '')) weights.set(box.id,'700');
        return false;
      } });
    renders.add(task);
    try { await task.promise; } finally { renders.delete(task); }
    if (token !== generation) throw new Error('PDF 已切换，请重试。');
    for (const box of targets) {
      if (!matched.has(box.id)) throw new Error('第 ' + pageModel.number + ' 页有文字无法定位替换，原文已保留。');
    }
    const surface = document.createElement('div'); surface.className = 'ezr-pdf-surface';
    surface.style.width = pageModel.width + 'px'; surface.style.height = pageModel.height + 'px';
    surface.appendChild(canvas);
    for (const box of pageModel.boxes) {
      const text = snapshot.get(key(pageModel.number,box));
      if (text === undefined) continue;
      const weight = weights.get(box.id) || (box.bold ? '700' : '400');
      const element = document.createElement('div'); element.className = 'ezr-pdf-text';
      element.dataset.box = key(pageModel.number,box);
      element.dataset.sourceFontSize = box.fontSize; element.dataset.fullText = text;
      element.dir = /[\u0590-\u08ff]/u.test(text) ? 'rtl' : 'ltr';
      Object.assign(element.style,{ left:box.left + 'px', top:box.top + 'px', width:box.width + 'px',
        height:box.height + 'px', transform:'rotate(' + box.angle + 'rad)',
        fontWeight:weight, color:colors.get(box.id) || '#000' });
      layoutElement(element,box,text,weight,fontSnapshot.get(element.dataset.box),alignmentSnapshot.get(element.dataset.box));
      textModels.set(element,{box,text,weight});
      surface.appendChild(element);
    }
    return surface;
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => { void paintVisible(); },100); }
  function mountSurface(pageModel, surface, version) {
    const pageView = viewer.getPageView(pageModel.number - 1);
    if (!pageView?.div || pageView.renderingState !== 3) return;
    surface.style.transform = 'scale(' + pageView.viewport.width / pageModel.width + ')';
    const overlay = document.createElement('div'); overlay.className = 'ezr-pdf-overlay'; overlay.appendChild(surface);
    editor.cancelDrag(); pageView.div.querySelector('.ezr-pdf-overlay')?.remove();
    pageView.div.appendChild(overlay); pageView.div.classList.add('ezr-pdf-translated');
    painted.set(pageView.div,{ revision:version }); editor.refresh();
  }
  function pageFailed(number, error, version) {
    failedPages.set(number,{ message:error.message || '页面显示失败，请重试。', revision:version });
    onError?.('第 ' + number + ' 页译文显示失败，原文已保留。可点击「重试失败页」。' + (error.message || ''));
    notify();
  }
  async function paintVisible() {
    syncEditLayers();
    if (busy || retrying || !parsed) return;
    busy = true;
    const token = generation, version = revision, snapshot = effectiveValues(), model = parsed;
    try {
      const bounds = container.getBoundingClientRect();
      for (const pageModel of model.pages) {
        const pageView = viewer.getPageView(pageModel.number - 1);
        if (!pageView?.div || pageView.renderingState !== 3) continue;
        const rect = pageView.div.getBoundingClientRect();
        if (rect.bottom < bounds.top - 100 || rect.top > bounds.bottom + 100) continue;
        const scale = pageView.viewport.width / pageModel.width;
        const previous = painted.get(pageView.div), old = pageView.div.querySelector('.ezr-pdf-overlay');
        if (old && previous?.revision === version) { old.firstChild.style.transform = 'scale(' + scale + ')'; continue; }
        if (failedPages.get(pageModel.number)?.revision === version) continue;
        if (!pageModel.boxes.some(box => snapshot.has(key(pageModel.number,box)))) {
          old?.remove(); pageView.div.classList.remove('ezr-pdf-translated'); failedPages.delete(pageModel.number); continue;
        }
        try {
          const surface = await renderPage(pageModel,snapshot);
          if (generation !== token || revision !== version) break;
          mountSurface(pageModel,surface,version);
          if (failedPages.delete(pageModel.number)) { if (!failedPages.size) onError?.(''); notify(); }
        } catch (error) {
          if (generation !== token || revision !== version) break;
          pageFailed(pageModel.number,error,version);
        }
      }
    } catch (error) { if (generation === token && revision === version) onError?.(error.message); }
    finally { busy = false; if (generation !== token || revision !== version) schedule(); }
  }
  async function retryFailedPages({ shouldContinue = () => true } = {}) {
    if (retrying || !parsed || !values.size) return;
    retrying = true; notify();
    const token = generation, version = revision, snapshot = effectiveValues(), model = parsed;
    const current = () => token === generation && version === revision && shouldContinue();
    try {
      while (busy && current()) await new Promise(resolve => setTimeout(resolve,20));
      for (const number of [...failedPages.keys()]) {
        if (!current()) break;
        const pageModel = model.pages.find(page => page.number === number);
        try {
          const surface = await renderPage(pageModel,snapshot,2,new Map(fontSizes),'print');
          if (!current()) break;
          mountSurface(pageModel,surface,version);
          failedPages.delete(number); if (!failedPages.size) onError?.(''); notify();
        } catch (error) { if (current()) pageFailed(number,error,version); }
      }
    } finally { retrying = false; notify(); schedule(); }
  }
  for (const name of ['pagerendered','scalechanging','pagechanging']) eventBus.on(name,schedule);
  eventBus.on('textlayerrendered',notify);
  container.addEventListener('scroll',schedule,{ passive:true });

  async function exportPreview(target, onProgress = () => {}) {
    if (!parsed || (!values.size && !originals.size)) throw new Error('请先翻译或标记需要保留原文的文本框。');
    const model = parsed, token = generation, version = revision, snapshot = effectiveValues(), fontSnapshot = new Map(fontSizes), alignmentSnapshot = new Map(alignments), originalSnapshot = new Set(originals);
    const output = target.document; output.title = model.title.replace(/\.pdf$/i,'') + ' - 译文';
    const css = output.createElement('style');
    css.textContent = PDF_TRANSLATION_CSS + `
      body{margin:0;background:#e9ecf0;font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}
      .export-actions{padding:16px;position:sticky;top:0;background:white;z-index:10}
      .export-actions button{font:inherit;padding:6px 14px;cursor:pointer}
      .export-page{position:relative;margin:16px auto;background:white;break-after:page}
      .export-page:last-child{break-after:auto}
      @media print{body{background:white}.export-actions{display:none}.export-page{margin:0}}
    `;
    output.head.appendChild(css);
    const actions = output.createElement('div'); actions.className = 'export-actions';
    const button = output.createElement('button'); button.textContent = '打印 / 保存为 PDF'; button.disabled = true;
    button.addEventListener('click',() => target.print());
    const hint = output.createElement('span'); hint.textContent = ' 正在准备全部页面…';
    actions.append(button,hint); output.body.replaceChildren(actions);
    for (const pageModel of model.pages) {
      if (generation !== token || target.closed) throw new Error('导出已取消，PDF 已切换或导出窗口已关闭。');
      onProgress(pageModel.number,model.pages.length);
      let surface;
      try { surface = await renderPage(pageModel,snapshot,2.5,fontSnapshot,'print',alignmentSnapshot); }
      catch (error) {
        if (generation === token && revision === version) pageFailed(pageModel.number,error,version);
        throw error;
      }
      if (generation !== token || target.closed) throw new Error('PDF 已切换，导出已取消。');
      const canvas = surface.querySelector('canvas'), img = output.createElement('img');
      img.src = canvas.toDataURL('image/png'); img.alt = ''; canvas.replaceWith(img); canvas.width = canvas.height = 0;
      const wrapper = output.createElement('section'); wrapper.className = 'export-page';
      wrapper.style.width = pageModel.width + 'pt'; wrapper.style.height = pageModel.height + 'pt';
      wrapper.style.page = 'pdfPage' + pageModel.number;
      css.textContent += '\n@page pdfPage' + pageModel.number + '{size:' + pageModel.width + 'pt ' + pageModel.height + 'pt;margin:0}';
      surface.style.transform = 'scale(' + 96 / 72 + ')'; wrapper.appendChild(output.adoptNode(surface));
      output.body.appendChild(wrapper);
      await img.decode();
    }
    await output.fonts.ready;
    if (generation !== token || target.closed) throw new Error('PDF 已切换，导出已取消。');
    const missing = groups.filter(group => !snapshot.has(group.id) && !originalSnapshot.has(group.id)).length, originalCount = originalSnapshot.size;
    hint.textContent = ' 在打印窗口中选择「另存为 PDF」。' + (originalCount ? originalCount + ' 个文本框按标记保留原文。' : '') + (missing > 0 ? '还有 ' + missing + ' 个文本框未翻译，已保留原文。' : '');
    button.disabled = false;
    return { pages:model.pages.length, translated:snapshot.size, remaining:missing, originals:originalCount };
  }
  function applyFontSize(size) {
    if (!editor.state.active || !editor.state.selected.length) return;
    if (size !== null && (!Number.isFinite(size) || size < 1 || size > 144)) throw new Error('字号请输入 1 到 144 之间的数值。');
    for (const id of editor.state.selected) {
      if (!values.has(id) || originals.has(id)) continue;
      if (size === null) fontSizes.delete(id); else fontSizes.set(id,size);
    }
    refreshTextLayouts();
  }
  function refreshTextLayouts() {
    const previous = revision++;
    for (const element of container.querySelectorAll('.ezr-pdf-text')) {
      const model = textModels.get(element);
      if (model && !originals.has(element.dataset.box) && editor.state.selected.includes(element.dataset.box)) {
        layoutElement(element,model.box,model.text,model.weight,fontSizes.get(element.dataset.box),alignments.get(element.dataset.box));
      }
    }
    // Font/alignment changes only affect the HTML text layer, not the PDF canvas.
    for (const page of container.querySelectorAll('.ezr-pdf-translated')) {
      if (painted.get(page)?.revision === previous) painted.set(page,{revision});
    }
    schedule(); editor.refresh();
  }
  function applyAlignment(axis, value) {
    const allowed = axis === 'horizontal' ? ['left','center','right'] : axis === 'vertical' ? ['top','middle','bottom'] : [];
    if (!allowed.includes(value)) throw new Error('请选择有效的文本框对齐方式。');
    if (!editor.state.active) return;
    for (const id of editor.state.selected) {
      if (values.has(id) && !originals.has(id)) alignments.set(id,{ ...alignments.get(id), [axis]:value });
    }
    refreshTextLayouts();
  }
  function markOriginal(value) {
    if (!editor.state.active || !parsed) return;
    const pages = new Set();
    for (const id of editor.state.selected) {
      if (originals.has(id) === !!value) continue;
      if (value) originals.add(id); else originals.delete(id);
      pages.add(Number(id.split(':')[0]));
    }
    if (!pages.size) return;
    const previous = revision++;
    // Remove stale translated canvases at once, so an in-flight repaint cannot flash a protected formula.
    for (const page of parsed.pages) {
      const view = viewer.getPageView(page.number - 1);
      if (pages.has(page.number)) {
        view?.div?.querySelector('.ezr-pdf-overlay')?.remove(); view?.div?.classList.remove('ezr-pdf-translated'); failedPages.delete(page.number);
      } else {
        if (painted.get(view?.div)?.revision === previous) painted.set(view.div,{revision});
        if (failedPages.get(page.number)?.revision === previous) failedPages.get(page.number).revision = revision;
      }
    }
    syncEditLayers(); publish(); schedule();
  }
  function bubbleSources() {
    const nodesOf = element => {
      if (!element) return [];
      const walker = document.createTreeWalker(element,4), nodes = []; let node;
      while ((node = walker.nextNode())) nodes.push(node);
      return nodes;
    };
    return (parsed?.pages || []).flatMap(page => {
      const view = viewer.getPageView(page.number - 1);
      const translated = new Map([...view?.div?.querySelectorAll('.ezr-pdf-text') || []].map(node => [node.dataset.box,node]));
      const textDivs = view?.textLayer?.highlighter?.textDivs || [];
      return page.boxes.map(box => {
        const id = key(page.number,box), element = translated.get(id);
        return { id, translated:!!element, nodes:element ? nodesOf(element) : box.items.flatMap(item => nodesOf(textDivs[item.index])) };
      });
    });
  }
  return { prepare:prepareGroups, apply, restore, reset, exportPreview, applyFontSize, applyAlignment, retryFailedPages, markOriginal, bubbleSources,
    isOriginal:id => originals.has(id),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setEditing:value => { syncEditLayers(); return editor.setActive(value); },
    setEditAvailable:value => { viewAvailable = !!value; editor.setAvailable(viewAvailable && !!getPdf()); },
    clearSelection:() => editor.clear(),
    get state() { return { boxes:groups.length, translated:effectiveValues().size, originals:[...originals], editing:editor.state.active, fontOverrides:fontSizes.size, pages:parsed?.pages.length || 0,
      alignmentOverrides:alignments.size, failedPages:[...failedPages.keys()].sort((a,b) => a - b), retrying }; },
    destroy() {
      reset(); listeners.clear(); editor.destroy(); clearTimeout(timer); style.remove();
      for (const name of ['pagerendered','scalechanging','pagechanging']) eventBus.off(name,schedule);
      container.removeEventListener('scroll',schedule);
    } };
}
