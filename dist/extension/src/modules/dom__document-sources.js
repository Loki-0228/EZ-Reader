/**
 * @file 发现当前网页的文档入口（PDF 与 Canvas 文件入口）。
 *
 * 只读 DOM：不发网络请求、不修改页面、不读取表单值、密码、脚本内容与隐藏 token，
 * 也不通读页面正文——只看链接与嵌入元素自身的 URL、type 属性和短标签。
 *
 * 识别依据（纯 DOM 规则，不联网核验）：
 * - a / embed / object / iframe / frame 上的 .pdf 扩展名、type 属性里的 PDF MIME、
 *   Canvas 文件路径 /files/<id>/download|preview（含 file_download / file_preview）、
 *   以及查询参数 file / src / url 中明确指向 PDF 或 Canvas 文件入口的源。
 * - Canvas preview 系动作改写为 download，查询串（verifier 等签名参数）原样保留。
 * - kind 只有两种：'pdf'（URL 或短标签带 .pdf，或 type 属性是 PDF MIME）、
 *   'document'（无扩展名但已明确是 Canvas 文件入口，由主任务做 PDF 签名验证）。
 *
 * 排除规则：
 * - 短文件名标签（可见文本 / aria-label / title / download / name）或 URL 文件名
 *   明确以非 PDF 文档扩展名结尾（.ppt / .pptx / .doc / .docx / .xls / .xlsx 等）
 *   的候选一律跳过，Canvas /files/<id>/download 也不例外。
 * - 扩展名未知的 Canvas 下载保留为候选，kind 记 'document'，交给主任务验签名。
 *
 * 已知边界（调用方需知晓）：
 * - 不发网络请求：地址是否真能下载、登录态与签名是否有效一律不核验。
 *   Canvas 等需登录站点无法在线访问验证，识别结果只以 DOM 规则为准。
 * - 跨域 iframe 是同源边界，本模块不进入，由调用方在每个帧内各调用一次后汇总；
 *   closed shadow root 不可见。
 * - 查询参数 file / src / url 只认目标自身带 .pdf 扩展名、或目标本身是 Canvas
 *   文件入口的源；参数指向其它无扩展名地址时不输出。
 * - 相对地址一律按元素 ownerDocument.baseURI 解析，拿不到时才退回被扫文档的基准。
 * - 无扩展名、无 type 属性、又不是 Canvas 文件链接的资源只能靠响应头
 *   Content-Type 定性，本模块识别不到。
 * - name 尽力而取（元素短标签 / aria-label / title / download / URL 文件名），
 *   取不到时为空字符串。
 * - 结果最多 24 项，按完整 URL（含查询串）去重，同一文件的两个签名 URL 各占一项。
 * - 扫描量有上限：open shadow root 与同源 iframe 各最多 24 个、元素最多 20000 个。
 */

/** 结果条数上限（契约：最多 24 项）。 */
const MAX_ITEMS = 24;
/** 单条 name 的最大长度（字符）。 */
const MAX_NAME_CHARS = 120;
/** 提取元素标签文本时最多读取的字符数。 */
const MAX_LABEL_CHARS = 240;
/** 提取元素标签文本时最多访问的节点数。 */
const MAX_LABEL_NODES = 200;
/** URL 查询参数 file / src / url 的最大嵌套层数。 */
const MAX_PARAM_DEPTH = 3;
/** 最多进入的 open shadow root 数量。 */
const MAX_SHADOW_ROOTS = 24;
/** 最多进入的同源 frame 文档数量。 */
const MAX_FRAMES = 24;
/** 最多访问的元素数量。 */
const MAX_NODES = 20000;

/** 允许的源协议；javascript: / data: / chrome-extension: 等一律拒绝。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'blob:']);

/** 明确危险或无意义的协议前缀，解析前先挡一道。 */
const REJECTED_PREFIX = /^(?:javascript|data|vbscript|about|chrome|edge|chrome-extension|moz-extension|filesystem):/i;

/** 带协议的字面量，用于识别整体编码过的文件地址。 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** 载体元素：链接与文档嵌入。frame 一并处理（老式框架页）。 */
const CANDIDATE_TAGS = new Set(['a', 'embed', 'object', 'iframe', 'frame']);

/** 不进入的子树：脚本、样式、模板与非文档内容（不读脚本与隐藏 token）。 */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base',
  'title', 'param', 'source', 'track', 'datalist', 'svg', 'math', 'canvas',
]);

/** 阅读器自身的宿主与浮层：整棵子树跳过，避免递归拾取自己的 UI。 */
const SELF_SELECTOR = '#ezr-root,[data-ezr-ui],#ezr-full-host,[data-ezr-pick-overlay],[data-ezr-toast]';

/** Canvas（及同类 LMS）文件动作路径：/files/<数字 id>/<动作>。 */
const CANVAS_FILE_RE = /\/files\/\d+\/(?:download|preview|file_download|file_preview)\/?$/i;

/** preview 系动作，转换成 download 时被替换的路径尾部。 */
const CANVAS_PREVIEW_RE = /\/(?:preview|file_preview)\/?$/i;

/** 页面型路径：作业页等页面本身不是文件，只允许其查询参数指向文档。 */
const PAGE_PATH_RE = /\/(?:assignments|assignment_submissions|quizzes|discussion_topics|discussion_entries|announcements|pages|modules|calendar|grades|users|settings|topics|conferences|eportfolios)(?:\/|$)/i;

/** 扩展名 → kind（只认 PDF）。 */
const EXT_KINDS = new Map([['pdf', 'pdf']]);

/** 能定性的扩展名（结尾锚定，只认 .pdf）。 */
const EXT_RE = /\.pdf$/i;

/** 明确非 PDF 的文件扩展名：短标签或 URL 文件名命中即整条跳过。 */
const NON_PDF_EXT_RE = /\.(?:pptx|ppt|ppsx|pps|potx|pot|docx|doc|dotx|dot|xlsx|xls|xltx|xlt|csv|odt|ods|odp|rtf|txt|zip|rar|7z|mp3|mp4|mov|avi|jpe?g|png|gif|webp|html?|exe|dmg|apk)$/i;

/** MIME → kind：用于识别无扩展名资源，只认 PDF 系。 */
const MIME_KINDS = new Map([
  ['application/pdf', 'pdf'],
  ['application/x-pdf', 'pdf'],
]);

/** 查询参数里承载文档地址的键。 */
const PARAM_KEYS = new Set(['file', 'src', 'url']);

/** URL 末段里不携带文件名的通用动作名，不能当 name。 */
const GENERIC_SEGMENTS = new Set([
  'download', 'preview', 'file', 'files', 'file_download', 'file_preview',
  'view', 'open', 'inline', 'get', 'document', 'documents', 'attachment',
]);

/**
 * 取元素标签名（小写）。
 * @param {unknown} el 节点。
 * @returns {string} 标签名，非元素返回 ''。
 */
function tagOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const name = el.tagName ?? el.nodeName ?? '';
  return typeof name === 'string' ? name.toLowerCase() : '';
}

/**
 * 安全读取元素属性。
 * @param {Element} el 元素。
 * @param {string} name 属性名。
 * @returns {string} 属性值，读不到返回 ''。
 */
function attr(el, name) {
  try {
    const value = el.getAttribute(name);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * 折叠空白并截断。
 * @param {string} raw 原始文本。
 * @returns {string} 清理后的文本（长度受 MAX_NAME_CHARS 限制）。
 */
function clampName(raw) {
  const text = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_NAME_CHARS ? text.slice(0, MAX_NAME_CHARS) : text;
}

/**
 * 一次性解码（含整体编码的地址），失败原样返回。
 * @param {string} value 待解码文本。
 * @returns {string} 解码结果。
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

/**
 * 判断元素（或其祖先）是否属于阅读器自身。
 * @param {Element} el 元素。
 * @returns {boolean} 是否阅读器自身节点。
 */
function isSelf(el) {
  try {
    if (el.id === 'ezr-root') return true;
    if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-ezr-ui')) return true;
    if (typeof el.closest === 'function' && el.closest(SELF_SELECTOR)) return true;
  } catch {
    /* 保守按外部节点处理 */
  }
  return false;
}

/**
 * 解析候选 URL：协议白名单 + 危险协议拦截。
 * @param {unknown} raw 属性里的原始值。
 * @param {string} base 解析基准（文档 baseURI）。
 * @returns {URL|null} 可用的 URL；空值、危险协议或解析失败返回 null。
 */
function resolveUrl(raw, base) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || REJECTED_PREFIX.test(trimmed)) return null;
  try {
    const url = base ? new URL(trimmed, base) : new URL(trimmed);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/**
 * 由扩展名定 kind。
 * @param {string} text 含扩展名的文本（URL 路径、文件名或标签）。
 * @returns {'pdf'|'document'|null} 定不出返回 null。
 */
function kindFromExt(text) {
  const match = EXT_RE.exec(safeDecode(text));
  return match ? EXT_KINDS.get(match[1].toLowerCase()) ?? null : null;
}

/**
 * 由 MIME 定 kind（识别无扩展名资源）。
 * @param {string} mime type 属性值。
 * @returns {'pdf'|'document'|null} 定不出返回 null。
 */
function kindFromMime(mime) {
  const normalized = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return normalized ? MIME_KINDS.get(normalized) ?? null : null;
}

/**
 * 路径是否是 LMS 页面（作业页等）——页面本身不是文件。
 * @param {string} path 解码后的路径。
 * @returns {boolean} 是否页面型路径。
 */
function isPagePath(path) {
  return PAGE_PATH_RE.test(String(path ?? ''));
}

/**
 * Canvas 文件动作路径转换：preview 系转 download，查询串（签名参数）原样保留。
 * @param {URL} url 原 URL。
 * @returns {string} 可下载的 URL 字符串。
 */
function canvasDownloadHref(url) {
  try {
    const out = new URL(url.href);
    out.pathname = out.pathname.replace(CANVAS_PREVIEW_RE, '/download');
    return out.href;
  } catch {
    return url.href;
  }
}

/**
 * 从 URL 路径末段取文件名。
 * @param {string} href URL 字符串。
 * @returns {string} 文件名；末段是动作名或纯数字 id 时返回 ''。
 */
function fileNameFromUrl(href) {
  try {
    const pathname = safeDecode(new URL(String(href)).pathname);
    const segment = pathname.split('/').filter(Boolean).pop() ?? '';
    const name = segment.trim();
    if (!name || /^\d+$/.test(name)) return '';
    return GENERIC_SEGMENTS.has(name.toLowerCase()) ? '' : name;
  } catch {
    return '';
  }
}

/**
 * 有限读取元素的标签文本（不读表单值，不通读页面）。
 * @param {Element} el 载体元素。
 * @returns {string} 折叠空白后的短标签。
 */
function labelText(el) {
  let out = '';
  let budget = MAX_LABEL_CHARS;
  let visited = 0;
  const stack = [el];
  while (stack.length && budget > 0 && visited < MAX_LABEL_NODES) {
    const node = stack.pop();
    if (!node) continue;
    if (node.nodeType === 3) {
      const text = String(node.nodeValue ?? '');
      out += text.slice(0, budget);
      budget -= text.length;
      continue;
    }
    if (node.nodeType !== 1) continue;
    visited += 1;
    const tag = tagOf(node);
    if (SKIP_TAGS.has(tag)) continue;
    const kids = node.childNodes ?? [];
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return out;
}

/**
 * 为结果条目挑名字：优先带 .pdf 扩展名的候选，其次按「可见文件名 / aria-label /
 * title / download / name 属性 / URL 文件名」的顺序取第一个非空值。
 * @param {Element} el 载体元素。
 * @param {string} href 结果 URL。
 * @returns {string} 受长度限制的文件名，取不到返回 ''。
 */
function pickName(el, href) {
  const candidates = [];
  const push = (value) => {
    const text = clampName(value);
    if (text) candidates.push(text);
  };
  push(labelText(el));
  push(attr(el, 'aria-label'));
  push(attr(el, 'title'));
  push(attr(el, 'download'));
  push(attr(el, 'name'));
  push(fileNameFromUrl(href));
  for (const candidate of candidates) {
    if (kindFromExt(candidate)) return candidate;
  }
  return candidates[0] ?? '';
}

/**
 * 短文件名标签或 URL 文件名是否明确写了非 PDF 的文档扩展名。
 * 命中即整条候选跳过：已知不是 PDF 的文件不再交给主任务试签名。
 * @param {Element} el 载体元素。
 * @param {string} href 候选 URL。
 * @returns {boolean} 标签以 .ppt / .pptx / .doc / .docx / .xls / .xlsx 等结尾返回 true。
 */
function hasNonPdfFileLabel(el, href) {
  const texts = [
    labelText(el),
    attr(el, 'aria-label'),
    attr(el, 'title'),
    attr(el, 'download'),
    attr(el, 'name'),
    fileNameFromUrl(href),
  ];
  return texts.some((text) => text && NON_PDF_EXT_RE.test(safeDecode(text)));
}

/**
 * 解析查询参数 file / src / url 中的文档地址。
 * 兼容整体编码的地址（如 Office viewer 的 src 参数），最多再解码一次。
 * @param {string} value 参数值。
 * @param {string} base 解析基准。
 * @returns {URL|null} 目标地址。
 */
function decodeParamTarget(value, base) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (!SCHEME_RE.test(text)) {
    const decoded = safeDecode(text).trim();
    if (decoded && decoded !== text && (SCHEME_RE.test(decoded) || decoded.startsWith('/'))) {
      text = decoded;
    }
  }
  return resolveUrl(text, base);
}

/**
 * 递归解析单个 URL，产出文档源。
 * @param {URL} url 候选 URL。
 * @param {number} depth 查询参数嵌套剩余层数。
 * @returns {{url: string, kind: 'pdf'|'document'|null}|null} 文档源。
 */
function classifyUrl(url, depth) {
  const path = safeDecode(url.pathname);
  if (!isPagePath(path)) {
    if (CANVAS_FILE_RE.test(path)) {
      return { url: canvasDownloadHref(url), kind: kindFromExt(path) || 'document' };
    }
    const extKind = kindFromExt(path);
    if (extKind) return { url: url.href, kind: extKind };
  }
  if (depth > 0) {
    const viaParam = classifyParam(url, depth);
    if (viaParam) return viaParam;
  }
  return null;
}

/**
 * 从查询参数 file / src / url 提取文档源，只认目标自身是 PDF 或 Canvas 文件入口的源。
 * @param {URL} url 候选 URL。
 * @param {number} depth 剩余嵌套层数。
 * @returns {{url: string, kind: 'pdf'|'document'|null}|null} 文档源。
 */
function classifyParam(url, depth) {
  let found = null;
  try {
    url.searchParams.forEach((value, key) => {
      if (found) return;
      if (!PARAM_KEYS.has(String(key).toLowerCase())) return;
      const target = decodeParamTarget(value, url.href);
      if (!target) return;
      const sub = classifyUrl(target, depth - 1);
      if (sub) found = sub;
    });
  } catch {
    /* URLSearchParams 不应抛异常，保险起见吞掉 */
  }
  return found;
}

/**
 * 收集一个结果条目（去重 + 上限）。
 * @param {object} ctx 扫描上下文。
 * @param {string} href 结果 URL。
 * @param {'pdf'|'document'} kind 已定出的 kind。
 * @param {Element} el 载体元素。
 */
function emit(ctx, href, kind, el) {
  if (ctx.out.length >= MAX_ITEMS) return;
  const key = String(href).split('#')[0];
  if (!key || ctx.seen.has(key)) return;
  const name = pickName(el, String(href));
  ctx.seen.add(key);
  const knownPdf = kind === 'pdf' || kindFromExt(name) === 'pdf';
  ctx.out.push({ url: String(href), name, kind: knownPdf ? 'pdf' : 'document' });
}

/**
 * 扫描单个载体元素（a / embed / object / iframe / frame）。
 * @param {Element} el 载体元素。
 * @param {object} ctx 扫描上下文。
 */
function collectFromElement(el, ctx) {
  const tag = tagOf(el);
  const raw = attr(el, tag === 'a' ? 'href' : tag === 'object' ? 'data' : 'src');
  const url = resolveUrl(raw, el.ownerDocument?.baseURI || ctx.base);
  if (!url) return;
  // 短文件名标签明确是非 PDF 文档（.pptx / .docx / .xlsx 等）时整条跳过。
  if (hasNonPdfFileLabel(el, url.href)) return;
  const direct = classifyUrl(url, MAX_PARAM_DEPTH);
  if (direct) {
    emit(ctx, direct.url, direct.kind, el);
    return;
  }
  // 页面本身（作业页等）永远不当文件；其余无扩展名资源凭 type 属性的 MIME 定性。
  if (isPagePath(safeDecode(url.pathname))) return;
  const mimeKind = kindFromMime(attr(el, 'type'));
  if (mimeKind) emit(ctx, url.href, mimeKind, el);
}

/**
 * 尝试进入同源 frame 文档；跨域 frame 在这里自然终止。
 * @param {Element} el iframe / frame 元素。
 * @param {object} ctx 扫描上下文。
 * @param {Array} stack 待扫描节点栈。
 */
function enterFrame(el, ctx, stack) {
  if (ctx.frameLeft <= 0) return;
  let inner = null;
  try {
    inner = el.contentDocument;
  } catch {
    return;
  }
  if (!inner) return;
  ctx.frameLeft -= 1;
  stack.push(inner);
}

/**
 * 压入子节点（逆序压栈，弹出时保持文档顺序）。
 * @param {Array} stack 待扫描节点栈。
 * @param {ArrayLike} kids 子节点集合。
 */
function pushChildren(stack, kids) {
  const list = kids ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) stack.push(list[i]);
}

/**
 * 发现当前网页的文档入口。
 *
 * 只读 DOM：不发网络请求、不修改页面、不读取表单值与脚本内容。
 * 扫描当前文档与有限数量的 open shadow root、同源 iframe；跨域 iframe 不越界，
 * 由调用方在每个帧内各调用一次本模块后自行汇总。
 *
 * @param {Document} [doc=document] 要扫描的文档，缺省为当前文档。
 * @returns {Array<{url: string, name: string, kind: 'pdf'|'document'}>}
 *   文档源列表（最多 24 项、按文档顺序、按 URL 去重）。
 */
export function findDocumentSources(doc = globalThis.document) {
  const out = [];
  if (!doc || typeof doc !== 'object') return out;
  const ctx = {
    out,
    seen: new Set(),
    base: '',
    shadowLeft: MAX_SHADOW_ROOTS,
    frameLeft: MAX_FRAMES,
    nodesLeft: MAX_NODES,
  };
  try {
    ctx.base = typeof doc.baseURI === 'string' ? doc.baseURI : '';
    if (!ctx.base && doc.defaultView && doc.defaultView.location) {
      ctx.base = String(doc.defaultView.location.href ?? '');
    }
  } catch {
    /* 拿不到基准时只处理绝对地址 */
  }
  const stack = [doc];
  while (stack.length && out.length < MAX_ITEMS && ctx.nodesLeft > 0) {
    const node = stack.pop();
    if (!node) continue;
    const type = node.nodeType;
    if (type === 9 || type === 11) {
      // Document / ShadowRoot（DocumentFragment）：继续向下。
      pushChildren(stack, node.children ?? node.childNodes);
      continue;
    }
    if (type !== 1) continue;
    ctx.nodesLeft -= 1;
    const el = node;
    if (isSelf(el)) continue;
    const tag = tagOf(el);
    if (SKIP_TAGS.has(tag)) continue;
    if (CANDIDATE_TAGS.has(tag)) collectFromElement(el, ctx);
    if (tag === 'iframe' || tag === 'frame') enterFrame(el, ctx, stack);
    if (el.shadowRoot) {
      if (ctx.shadowLeft > 0) {
        ctx.shadowLeft -= 1;
        stack.push(el.shadowRoot);
      }
    }
    pushChildren(stack, el.children);
  }
  return out;
}
