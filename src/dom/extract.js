/**
 * @file 提取流水线：定位内容根 → 扫描成 IR → 判级 → 拆行 → 重判 → 分配标题层级。
 * 依赖 core 的 classify/split/heading-levels/score/selector（CONTRACTS.md §5~§11）。
 */

import { DEFAULT_SETTINGS } from '../core/constants.js';
import { classifyBlock } from '../core/classify.js';
import { assignHeadingLevels } from '../core/heading-levels.js';
import { pickBest, scoreCandidate } from '../core/score.js';
import { cssPath, isValidPath } from '../core/selector.js';
import { splitAll } from '../core/split.js';
import { getDoc } from './env.js';
import { scanDocument } from './scan.js';

/** 低于该字符数视为「没有可读内容」。 */
const MIN_TEXT_CHARS = 80;
/** 通用容器候选的上限，避免超大页面统计开销。 */
const MAX_CANDIDATES = 400;
/** 优先候选（main/article/[role=main]）在最优分的这个比例内即被优先采用。 */
const PRIMARY_TOLERANCE = 0.1;

/**
 * 在文档中安全执行选择器。
 * @param {Document} doc 文档。
 * @param {string} selector CSS 选择器。
 * @returns {Element|null} 首个匹配元素，失败为 null。
 */
function safeQuery(doc, selector) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  try {
    return doc.querySelector(selector) ?? null;
  } catch {
    return null;
  }
}

/**
 * 元素是否仍挂在文档上（stub 环境缺少 isConnected 时按 true 处理）。
 * @param {Element} el 元素。
 * @returns {boolean} 是否已连接。
 */
function isConnected(el) {
  if (!el) return false;
  return el.isConnected === undefined ? true : el.isConnected === true;
}

/**
 * 取得提取根。顺序：显式选区 → srcPath 查询 → null。
 * @param {{doc?: Document, srcPath?: string|null, selection?: (Element|string|null)}} [opts] 选项。
 *   `selection` 既接受 picker 选中的 Element，也接受 CSS 路径字符串。
 * @returns {Element|null} 提取根元素。
 */
export function resolveRoot(opts = {}) {
  const doc = opts.doc ?? getDoc();
  const selection = opts.selection;
  let el = null;

  if (selection && typeof selection === 'string') {
    if (isValidPath(selection)) el = safeQuery(doc, selection);
  } else if (selection && selection.nodeType === 1) {
    el = selection;
  } else if (selection && selection.el && selection.el.nodeType === 1) {
    el = selection.el;
  }
  if (el && isConnected(el)) return el;

  const path = opts.srcPath;
  if (typeof path === 'string' && isValidPath(path)) {
    const found = safeQuery(doc, path);
    if (found && isConnected(found)) return found;
  }
  return null;
}

/**
 * 计算元素到 documentElement 的深度。
 * @param {Element} el 元素。
 * @param {Document} doc 文档。
 * @returns {number} 深度（documentElement 为 0）。
 */
function depthOf(el, doc) {
  let depth = 0;
  let node = el;
  const rootEl = doc ? doc.documentElement : null;
  while (node && node !== rootEl && node.parentElement && depth < 512) {
    depth += 1;
    node = node.parentElement;
  }
  return depth;
}

/**
 * 生成候选路径字符串（cssPath 失败时退回标签名 + 深度）。
 * @param {Element} el 元素。
 * @param {number} depth 深度。
 * @returns {string} 路径字符串。
 */
function pathOf(el, depth) {
  try {
    const p = cssPath(el);
    if (typeof p === 'string' && p) return p;
  } catch {
    /* 退回到标签名 */
  }
  const tag = el && el.tagName ? String(el.tagName).toLowerCase() : 'node';
  return `${tag}:depth${depth}`;
}

/**
 * 计算 score.js 需要的候选统计量。
 * 注意：linkTextLength 不计非 <a> 内的链接文本，与原契约一致。
 * @param {Element} el 候选元素。
 * @returns {{paraCount:number,textLength:number,linkTextLength:number,className:string,id:string,tagName:string}} stats。
 */
function statsOf(el) {
  let paraCount = 0;
  let textLength = 0;
  let linkTextLength = 0;
  try {
    const ps = el.getElementsByTagName ? el.getElementsByTagName('p') : null;
    paraCount = ps ? ps.length : 0;
  } catch {
    paraCount = 0;
  }
  try {
    textLength = typeof el.textContent === 'string' ? el.textContent.length : 0;
  } catch {
    textLength = 0;
  }
  try {
    const links = el.getElementsByTagName ? el.getElementsByTagName('a') : null;
    if (links) {
      for (let i = 0; i < links.length; i++) {
        const t = links[i].textContent;
        if (typeof t === 'string') linkTextLength += t.length;
      }
    }
  } catch {
    linkTextLength = 0;
  }
  return {
    paraCount,
    textLength,
    linkTextLength,
    className: typeof el.className === 'string' ? el.className : '',
    id: typeof el.id === 'string' ? el.id : '',
    tagName: el.tagName ? String(el.tagName).toLowerCase() : '',
  };
}

/**
 * 是否为优先候选（main / article / [role=main]）。
 * @param {Object} candidate 候选 `{ stats, depth, path, el }`。
 * @returns {boolean} 是否优先候选。
 */
function isPrimaryCandidate(candidate) {
  const tag = candidate.stats.tagName;
  if (tag === 'main' || tag === 'article') return true;
  try {
    const role = candidate.el.getAttribute ? candidate.el.getAttribute('role') : null;
    return typeof role === 'string' && role.toLowerCase() === 'main';
  } catch {
    return false;
  }
}

/**
 * 挑选最佳内容根：`main, article, [role=main], .content, #content, body`
 * 加「≥3 个段落」的通用 section/div 容器，交给 `pickBest` 决出；无候选时退回 body。
 * @param {{doc?: Document, settings?: Object}} [opts] 选项。
 * @returns {Element|null} 内容根元素。
 */
export function findBestRoot(opts = {}) {
  const doc = opts.doc ?? getDoc();
  const candidates = [];
  const byPath = new Map();
  const seen = new Set();

  /**
   * @param {Element} el 候选元素。
   */
  const push = (el) => {
    if (!el || el.nodeType !== 1 || seen.has(el)) return;
    if (candidates.length >= MAX_CANDIDATES) return;
    seen.add(el);
    const depth = depthOf(el, doc);
    const path = pathOf(el, depth);
    const candidate = { stats: statsOf(el), depth, path, el };
    candidates.push(candidate);
    if (!byPath.has(path)) byPath.set(path, candidate);
  };

  const explicitSelectors = ['main', 'article', '[role="main"]', '.content', '#content', 'body'];
  for (const selector of explicitSelectors) {
    let list = null;
    try {
      list = doc.querySelectorAll(selector);
    } catch {
      list = null;
    }
    if (!list) continue;
    for (let i = 0; i < list.length; i++) push(list[i]);
  }

  let generics = null;
  try {
    generics = doc.querySelectorAll('section, div');
  } catch {
    generics = null;
  }
  if (generics) {
    for (let i = 0; i < generics.length; i++) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const el = generics[i];
      let paraCount = 0;
      try {
        const ps = el.getElementsByTagName ? el.getElementsByTagName('p') : null;
        paraCount = ps ? ps.length : 0;
      } catch {
        paraCount = 0;
      }
      if (paraCount >= 3) push(el);
    }
  }

  const fallback = doc.body ?? doc.documentElement ?? null;
  if (candidates.length === 0) return fallback;

  let best = null;
  try {
    best = pickBest(candidates);
  } catch {
    best = null;
  }

  /** @type {Object|null} */
  let bestCandidate = null;
  if (best === null || best === undefined) bestCandidate = null;
  else if (typeof best === 'number' && candidates[best]) bestCandidate = candidates[best];
  else if (typeof best === 'string') bestCandidate = byPath.get(best) ?? null;
  else if (typeof best === 'object') {
    if (candidates.includes(best)) bestCandidate = best;
    else if (seen.has(best.el ?? null)) bestCandidate = candidates.find((c) => c.el === best.el) ?? null;
    else if (typeof best.path === 'string') bestCandidate = byPath.get(best.path) ?? null;
  }
  if (!bestCandidate || !bestCandidate.el) return fallback;

  let bestScore = 0;
  try {
    bestScore = scoreCandidate(bestCandidate.stats);
  } catch {
    bestScore = 0;
  }
  if (!Number.isFinite(bestScore)) bestScore = 0;

  // 优先 main / article / [role=main]：只要其得分落在最优分的 10% 以内。
  let primary = null;
  let primaryScore = -Infinity;
  for (const candidate of candidates) {
    if (!isPrimaryCandidate(candidate)) continue;
    let s = 0;
    try {
      s = scoreCandidate(candidate.stats);
    } catch {
      s = 0;
    }
    if (!Number.isFinite(s)) continue;
    if (s > primaryScore) {
      primaryScore = s;
      primary = candidate;
    }
  }
  if (primary && primaryScore >= bestScore - Math.abs(bestScore) * PRIMARY_TOLERANCE) {
    return primary.el;
  }
  return bestCandidate.el;
}

/**
 * 应用判级：不可变合并 `classifyBlock` 的结果。
 * @param {Object} block IR 块。
 * @param {Object} ctx 判级上下文。
 * @returns {Object} 新块对象。
 */
function classifySafe(block, ctx) {
  let patch = null;
  try {
    patch = classifyBlock(block, ctx);
  } catch {
    patch = null;
  }
  if (!patch || typeof patch !== 'object') return block;
  return { ...block, ...patch };
}

/**
 * 由元素构建 IR 文档：scan → classify → split → 重判 → assignHeadingLevels。
 * @param {Element} el 提取根元素。
 * @param {{doc?: Document, settings?: Object, minTextChars?: number}} [opts] 手动选择允许短文本。
 * @returns {Object|null} IrDoc；无可读内容时为 null。
 */
export function buildDocFromElement(el, opts = {}) {
  if (!el || el.nodeType !== 1) return null;
  const doc = opts.doc ?? el.ownerDocument ?? getDoc();
  const settings = opts.settings ?? DEFAULT_SETTINGS;

  let ir = null;
  try {
    ir = scanDocument(el, { doc });
  } catch {
    return null;
  }
  if (!ir || !Array.isArray(ir.blocks) || ir.blocks.length === 0) return null;

  const mode = settings.headingMode;
  const ctx = {
    bodyFontSize: ir.body && ir.body.fontSize > 0 ? ir.body.fontSize : 16,
    bodyLineHeightPx: ir.body && ir.body.lineHeightPx > 0 ? ir.body.lineHeightPx : 19.2,
    mode: mode === 'conservative' || mode === 'aggressive' ? mode : 'standard',
  };

  let blocks = ir.blocks.map((b) => classifySafe(b, ctx));

  if (settings.splitLines !== false) {
    try {
      const split = splitAll(blocks);
      if (Array.isArray(split) && split.length > 0) blocks = split;
    } catch {
      /* 拆分失败时保留原块 */
    }
    // 拆出来的新块需要重新判级
    blocks = blocks.map((b) => classifySafe(b, ctx));
  }

  try {
    const leveled = assignHeadingLevels(blocks);
    if (Array.isArray(leveled) && leveled.length > 0) blocks = leveled;
  } catch {
    /* 层级分配失败时保留已有 level */
  }

  blocks = blocks.filter((b) => b && typeof b === 'object' && typeof b.text === 'string');
  if (blocks.length === 0) return null;

  let totalText = 0;
  for (const b of blocks) totalText += b.text.length;
  const minimum = Number.isFinite(opts.minTextChars) ? Math.max(1, opts.minTextChars) : MIN_TEXT_CHARS;
  if (totalText < minimum) return null;

  let srcPath = typeof ir.srcPath === 'string' ? ir.srcPath : '';
  if (!srcPath) {
    try {
      const p = cssPath(el);
      if (typeof p === 'string') srcPath = p;
    } catch {
      srcPath = '';
    }
  }

  return {
    blocks,
    body: ir.body,
    title: typeof ir.title === 'string' ? ir.title : '',
    srcPath,
    truncated: ir.truncated === true,
  };
}

/**
 * 完整提取流水线。
 * @param {{doc?: Document, selection?: (Element|string|null), srcPath?: string|null, settings?: Object}} [opts] 选项。
 * @returns {Object|null} IrDoc；没有可提取内容时为 null。
 */
export function extract(opts = {}) {
  const doc = opts.doc ?? getDoc();
  const settings = opts.settings ?? DEFAULT_SETTINGS;

  let root = null;
  try {
    root = resolveRoot({ doc, srcPath: opts.srcPath, selection: opts.selection });
  } catch {
    root = null;
  }
  if (!root) {
    try {
      root = findBestRoot({ doc, settings });
    } catch {
      root = doc.body ?? doc.documentElement ?? null;
    }
  }
  if (!root) return null;

  try {
    return buildDocFromElement(root, { doc, settings });
  } catch {
    return null;
  }
}

/**
 * 统计 IR 文档的规模信息。
 * @param {Object} irDoc IR 文档。
 * @returns {{chars:number, words:number, cjkRatio:number}} `chars` 为各块文本长度之和；
 *   `words` 为 CJK 逐字计数 + 非 CJK 词元计数；`cjkRatio` 为 CJK 字符 / 总字母数（0..1）。
 */
export function textStats(irDoc) {
  const blocks = irDoc && Array.isArray(irDoc.blocks) ? irDoc.blocks : [];
  let chars = 0;
  const parts = [];
  for (const b of blocks) {
    const t = b && typeof b.text === 'string' ? b.text : '';
    chars += t.length;
    if (t) parts.push(t);
  }
  const text = parts.join('\n');
  const cjkChars = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const letters = (text.match(/\p{L}/gu) || []).length;
  const nonCjk = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ');
  const latinWords = (nonCjk.match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu) || []).length;
  return {
    chars,
    words: cjkChars + latinWords,
    cjkRatio: letters > 0 ? cjkChars / letters : 0,
  };
}
