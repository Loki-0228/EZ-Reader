import { containsBaseline, fitText } from './layout.js';

const FONT = "'Segoe UI','Microsoft YaHei','Noto Sans',sans-serif";
const canonical = text => text.replace(/\s+/gu,' ').trim();
const key = (page,box) => page + ':' + box.id;
export const PDF_TRANSLATION_CSS = `
.ezr-pdf-overlay{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:visible}
.ezr-pdf-surface{position:absolute;left:0;top:0;transform-origin:0 0}
.ezr-pdf-surface canvas,.ezr-pdf-surface img{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ezr-pdf-text{position:absolute;box-sizing:content-box;margin:0;padding:0;border:0;transform-origin:0 0;white-space:pre;overflow:visible;pointer-events:auto;font-family:${FONT};text-align:start;text-transform:none;font-kerning:normal}
.ezr-pdf-text span{display:block;white-space:pre}
.ezr-pdf-translated .textLayer{visibility:hidden}
`;

/** Keep PDF graphics in place and replace only completed text boxes. */
export function createPdfTranslation({ viewer, eventBus, container, getPdf, prepare, onError, onChange }) {
  let parsed = null, groups = [], values = new Map(), revision = 0, generation = 0, timer = 0, busy = false;
  const painted = new WeakMap(), renders = new Set();
  const style = document.createElement('style'); style.textContent = PDF_TRANSLATION_CSS; document.head.appendChild(style);

  async function prepareGroups() {
    const result = await prepare();
    if (parsed !== result) {
      parsed = result;
      groups = parsed.pages.flatMap(page => page.boxes.filter(box => /\p{L}/u.test(box.text))
        .map(box => ({ id:key(page.number,box), source:canonical(box.text) })));
    }
    return groups;
  }
  function clearLayers() {
    container.querySelectorAll('.ezr-pdf-overlay').forEach(layer => layer.remove());
    container.querySelectorAll('.ezr-pdf-translated').forEach(page => page.classList.remove('ezr-pdf-translated'));
  }
  function restore() { revision++; values = new Map(); clearLayers(); onChange?.(0,groups.length); }
  function reset() {
    generation++; parsed = null; groups = []; restore();
    for (const task of renders) task.cancel();
  }
  function apply(entries) {
    const next = new Map(entries.map(entry => [entry.id,entry.text]));
    if (next.size === values.size && [...next].every(([id,text]) => values.get(id) === text)) return;
    values = next; revision++; onChange?.(values.size,groups.length); schedule();
  }
  async function renderPage(pageModel, snapshot, scale = 2) {
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
    const task = page.render({ canvasContext:context, viewport, annotationMode:0,
      textFilter(info) {
        if (!info.text.trim()) return true;
        const box = targets.find(box => containsBaseline(box,info.x / renderScale,info.y / renderScale));
        if (!box) return true;
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
    const measure = document.createElement('canvas').getContext('2d');
    for (const box of pageModel.boxes) {
      const text = snapshot.get(key(pageModel.number,box));
      if (text === undefined) continue;
      const weight = weights.get(box.id) || (box.bold ? '700' : '400');
      const layout = fitText(text,box,(value,size) => {
        measure.font = weight + ' ' + size + 'px ' + FONT;
        const metrics = measure.measureText(value);
        return { width:Math.max(metrics.width,metrics.actualBoundingBoxRight + Math.max(0,metrics.actualBoundingBoxLeft)) + size * .02,
          height:metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent };
      });
      const element = document.createElement('div'); element.className = 'ezr-pdf-text';
      element.dataset.box = key(pageModel.number,box); element.dataset.fontSize = layout.fontSize;
      element.dataset.sourceFontSize = box.fontSize; element.dataset.fullText = text;
      element.dir = /[\u0590-\u08ff]/u.test(text) ? 'rtl' : 'ltr';
      Object.assign(element.style,{ left:box.left + 'px', top:box.top + 'px', width:box.width + 'px',
        height:box.height + 'px', transform:'rotate(' + box.angle + 'rad)', fontSize:layout.fontSize + 'px',
        fontWeight:weight, lineHeight:String(layout.lineHeight), color:colors.get(box.id) || '#000' });
      for (const line of layout.lines) { const span = document.createElement('span'); span.textContent = line || '\u200b'; element.appendChild(span); }
      surface.appendChild(element);
    }
    return surface;
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => { void paintVisible(); },100); }
  async function paintVisible() {
    if (busy || !parsed || !values.size) return;
    busy = true;
    const token = generation, version = revision, snapshot = new Map(values), model = parsed;
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
        if (!pageModel.boxes.some(box => snapshot.has(key(pageModel.number,box)))) continue;
        const surface = await renderPage(pageModel,snapshot);
        if (generation !== token || revision !== version) break;
        surface.style.transform = 'scale(' + scale + ')';
        const overlay = document.createElement('div'); overlay.className = 'ezr-pdf-overlay'; overlay.appendChild(surface);
        old?.remove(); pageView.div.appendChild(overlay); pageView.div.classList.add('ezr-pdf-translated');
        painted.set(pageView.div,{ revision:version });
      }
    } catch (error) { if (generation === token) onError?.(error.message); }
    finally { busy = false; if (generation !== token || revision !== version) schedule(); }
  }
  for (const name of ['pagerendered','scalechanging','pagechanging']) eventBus.on(name,schedule);
  container.addEventListener('scroll',schedule,{ passive:true });

  async function exportPreview(target, onProgress = () => {}) {
    if (!parsed || !values.size) throw new Error('请先完成至少一个文本框的翻译。');
    const model = parsed, token = generation, snapshot = new Map(values);
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
      const surface = await renderPage(pageModel,snapshot,2.5);
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
    const missing = groups.length - snapshot.size;
    hint.textContent = ' 在打印窗口中选择「另存为 PDF」。' + (missing > 0 ? '还有 ' + missing + ' 个文本框未翻译，已保留原文。' : '');
    button.disabled = false;
    return { pages:model.pages.length, translated:snapshot.size, remaining:missing };
  }
  return { prepare:prepareGroups, apply, restore, reset, exportPreview,
    get state() { return { boxes:groups.length, translated:values.size, pages:parsed?.pages.length || 0 }; },
    destroy() {
      reset(); clearTimeout(timer); style.remove();
      for (const name of ['pagerendered','scalechanging','pagechanging']) eventBus.off(name,schedule);
      container.removeEventListener('scroll',schedule);
    } };
}
