import * as pdfjs from '../vendor/pdfjs/pdf.mjs';
import { openPdfDocument, extractPdfText } from '../documents/parser.js';
globalThis.pdfjsLib = pdfjs;
const { PDFViewer, EventBus } = await import('../vendor/pdfjs/pdf_viewer.mjs');
const MAX_BYTES = 50 * 1024 * 1024;
const container = document.getElementById('pdf-container');
const status = document.getElementById('pdf-status');
const sourceForm = document.getElementById('source-form');
const sourceSelect = document.getElementById('pdf-source');
const fileInput = document.getElementById('pdf-file');
const pageInput = document.getElementById('pdf-page');
const totalLabel = document.getElementById('pdf-total');
const controller = new AbortController(), eventBus = new EventBus();
const viewer = new PDFViewer({ container, viewer:document.getElementById('pdf-pages'), eventBus,
  annotationMode:0, textLayerMode:1, enableAutoLinking:false, enableDetailCanvas:false,
  maxCanvasPixels:8_388_608, abortSignal:controller.signal });
let documentJob = null, loadController = null, generation = 0, extraction = null, sources = [];
const message = text => { status.textContent = text; status.hidden = !text; };
const toolbar = () => globalThis.__ezr.send({ type:'ezr:toolbar-open' });
function busy(value) { fileInput.disabled = value; document.getElementById('cancel-load').hidden = !value; }
eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; });
eventBus.on('pagechanging', ({ pageNumber }) => { pageInput.value = pageNumber; });
pageInput.addEventListener('change', () => { if (documentJob) viewer.currentPageNumber = Math.max(1, Math.min(documentJob.pdf.numPages, Number(pageInput.value) || 1)); });
document.getElementById('pdf-fit').addEventListener('click', () => { if (documentJob) viewer.currentScaleValue = 'page-width'; });
document.getElementById('open-toolbar').addEventListener('click', () => { void toolbar(); });
document.getElementById('cancel-load').addEventListener('click', () => loadController?.abort());
async function fetchBytes(url, signal) {
  const parsed = new URL(url);
  if (!['http:','https:','file:','blob:'].includes(parsed.protocol)) throw new Error('PDF 链接不受支持。');
  const response = await fetch(parsed.href, { credentials:'include', signal });
  if (!response.ok) throw new Error('PDF 下载失败（HTTP ' + response.status + '），可从原页面下载后打开。');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('PDF 超过 50 MB，请拆分后打开。');
  const stream = response.body?.getReader();
  if (!stream) throw new Error('PDF 下载没有返回内容。');
  const chunks = []; let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await stream.read(); if (done) break;
      length += value.length; if (length > MAX_BYTES) throw new Error('PDF 超过 50 MB，请拆分后打开。');
      chunks.push(value);
    }
  } finally { await stream.cancel().catch(() => {}); }
  const data = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}
async function load(file, source) {
  const id = ++generation;
  loadController?.abort(); loadController = new AbortController(); const signal = loadController.signal;
  extraction = null; globalThis.__ezr.close(); globalThis.__ezr.setPdfDocument(null);
  viewer.setDocument(null); await documentJob?.destroy().catch(() => {}); documentJob = null;
  busy(true); message('正在打开 PDF…');
  try {
    if (file?.size > MAX_BYTES) throw new Error('PDF 超过 50 MB，请拆分后打开。');
    const data = file ? new Uint8Array(await file.arrayBuffer()) : await fetchBytes(source.url, signal);
    signal.throwIfAborted();
    const job = await openPdfDocument(data, { signal });
    if (id !== generation) { await job.destroy(); return; }
    documentJob = job; document.title = file?.name || source?.name || 'PDF 阅读';
    viewer.setDocument(job.pdf); pageInput.max = job.pdf.numPages; pageInput.value = 1; totalLabel.textContent = '/ ' + job.pdf.numPages;
    sourceForm.hidden = true; message('');
    await toolbar();
  } catch (error) {
    if (id !== generation) return;
    message(signal.aborted ? '已停止打开 PDF。' : error instanceof TypeError ? '此 PDF 链接无法读取。可从原预览下载后点击「打开文件」。' : error.message);
  } finally { if (id === generation) busy(false); }
}
// Text extraction is only needed when entering the text reading/translation view.
globalThis.__ezrPreparePdf = async () => {
  if (!documentJob) throw new Error('PDF 尚未打开，请先选择文件。');
  const id = generation;
  extraction ||= extractPdfText(documentJob.pdf, { name:document.title, signal:loadController.signal,
    onProgress:({ current,total }) => { if (id === generation) message('正在准备文字：' + current + ' / ' + total + ' 页'); } });
  try {
    const parsed = await extraction;
    if (id !== generation) throw new Error('PDF 已切换，请重新打开翻译。');
    globalThis.__ezr.setPdfDocument(parsed); message(''); return parsed;
  } catch (error) { if (id === generation) { extraction = null; message(error.message); } throw error; }
};
fileInput.addEventListener('change', () => { const file = fileInput.files[0]; fileInput.value = ''; if (file) void load(file); });
sourceForm.addEventListener('submit', event => { event.preventDefault(); const source = sources[Number(sourceSelect.value)]; if (source) void load(null, source); });
// The PDF remains visible beneath the same top/bottom toolbar stack as a webpage.
const navigationResize = new ResizeObserver(() => document.documentElement.style.setProperty('--pdf-nav-height', document.getElementById('pdf-navigation').getBoundingClientRect().height + 'px'));
navigationResize.observe(document.getElementById('pdf-navigation'));
let observedHost;
const resize = new ResizeObserver(() => fitTools());
function fitTools() {
  const host = document.getElementById('ezr-root');
  if (host !== observedHost) {
    resize.disconnect(); observedHost = host;
    if (host?.shadowRoot?.querySelector('.ezr-toolbar-host')) resize.observe(host.shadowRoot.querySelector('.ezr-toolbar-host'));
  }
  const height = host?.hasAttribute('data-ezr-original') ? host.shadowRoot.querySelector('.ezr-toolbar-host')?.getBoundingClientRect().height || 0 : 0;
  const bottom = host?.getAttribute('data-ezr-dock') === 'bottom';
  document.documentElement.style.setProperty('--ezr-top-inset', (bottom ? 0 : height) + 'px');
  document.documentElement.style.setProperty('--ezr-bottom-inset', (bottom ? height : 0) + 'px');
}
const mutations = new MutationObserver(fitTools); mutations.observe(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['data-ezr-original','data-ezr-dock'] });
window.addEventListener('pagehide', () => { generation++; loadController?.abort(); controller.abort(); mutations.disconnect(); resize.disconnect(); navigationResize.disconnect(); globalThis.__ezr.close(); void documentJob?.destroy().catch(() => {}); });
async function init() {
  const id = location.hash.slice(1);
  if (!/^[\da-f-]{36}$/i.test(id)) { message('从 PDF 页面点击扩展的「打开 PDF」，或选择本地 PDF 文件。'); return; }
  try {
    const key = 'ezr:document:entry:' + id;
    const entry = (await chrome.storage.session.get(key))[key];
    if (!entry || Date.now() - entry.created > 30 * 60 * 1000) throw new Error('PDF 入口已过期，请从原页面重新打开。');
    if (entry.selectionText) {
      message('已读取浏览器提供的选中文字。');
      await globalThis.__ezr.send({ type:'ezr:translate-selection', text:entry.selectionText }); return;
    }
    sources = entry.sources || [];
    if (sources.length === 1) { await load(null, sources[0]); return; }
    for (const [index, source] of sources.entries()) {
      const option = document.createElement('option'); option.value = index; option.textContent = source.name || 'PDF ' + (index + 1); sourceSelect.append(option);
    }
    sourceForm.hidden = !sources.length;
    message(sources.length ? '选择要打开的 PDF。' : '未找到可读取的 PDF 地址。可从原预览下载 PDF 后点击「打开文件」。');
  } catch (error) { message(error.message); }
}
void init();