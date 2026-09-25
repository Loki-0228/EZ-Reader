import * as pdfjs from '../vendor/pdfjs/pdf.mjs';
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 1000;
const MAX_TEXT = 2_000_000;
export async function openPdfDocument(data, { signal, password } = {}) {
  signal?.throwIfAborted();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('请选择不超过 50 MB 的 PDF。');
  if (!new TextDecoder('latin1').decode(bytes.subarray(0,1024)).includes('%PDF-')) throw new Error('此链接没有返回 PDF，可能是登录页面。请从原页面下载 PDF 后打开。');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({ data:bytes, password,
    cMapUrl:new URL('../vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked:true,
    standardFontDataUrl:new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported:false, enableXfa:false, useWasm:false });
  const abort = () => { void task.destroy().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once:true });
  try {
    const pdf = await task.promise;
    signal?.throwIfAborted();
    if (pdf.numPages > MAX_PAGES) throw new Error('PDF 超过 1000 页，请拆分后打开。');
    return { pdf, destroy:async () => { signal?.removeEventListener('abort', abort); await task.destroy(); } };
  } catch (error) {
    signal?.removeEventListener('abort', abort); await task.destroy().catch(() => {});
    signal?.throwIfAborted();
    if (error.name === 'PasswordException') throw new Error('PDF 已加密，请解除密码后打开。');
    throw error;
  }
}
export async function extractPdfText(pdf, { name = 'PDF', signal, onProgress = () => {} } = {}) {
  const pages = []; let total = 0;
  for (let number = 1; number <= pdf.numPages; number++) {
    signal?.throwIfAborted();
    const page = await pdf.getPage(number), content = await page.getTextContent();
    const parts = []; let previous = null, length = 0;
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      length += item.str.length + 1;
      if (total + length > MAX_TEXT) throw new Error('PDF 文字超过 200 万字符，仍可阅读原文；全文翻译前请拆分文件。');
      if (previous && parts.length && !parts.at(-1).endsWith('\n')) {
        const dy = Math.abs((item.transform?.[5] || 0) - (previous.transform?.[5] || 0));
        parts.push(dy > Math.max(2,(item.height || previous.height || 8) * .6) ? '\n' : ' ');
      }
      parts.push(item.str + (item.hasEOL ? '\n' : '')); previous = item;
    }
    const text = parts.join('').trim(); total += text.length;
    pages.push({ title:'第 ' + number + ' 页', text });
    onProgress({ current:number, total:pdf.numPages });
    await new Promise(resolve => setTimeout(resolve,0));
  }
  signal?.throwIfAborted();
  if (!pages.some(page => page.text)) throw new Error('PDF 没有可提取的文字，扫描件需要先识别文字。');
  return { title:name, format:'pdf', pages };
}