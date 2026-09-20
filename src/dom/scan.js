/**
 * @file 把真实 DOM 编译成 IR（CONTRACTS.md §1）。
 * 单次深度优先遍历：每个候选元素最多调用一次 getComputedStyle，
 * 全程只读（不修改页面），任何单块失败都只跳过该块。
 */

import { MAX_BLOCKS, escapeHtml } from '../core/constants.js';
import { sanitizeInline, inlineNodes } from '../core/sanitize.js';
import { cssPath } from '../core/selector.js';
import { getDoc, isVisible, lineHeightPx, px, rectOf, styleOf } from './env.js';

/** 从不渲染的标签：整棵子树忽略（既不产出块，也不阻断祖先）。 */
const NEVER_TRAVERSE = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title',
  'base', 'datalist', 'param', 'source', 'track',
]);

/** 契约要求整体跳过的标签：自身永不产出块。 */
const SKIP_EMIT = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'textarea',
  'select', 'option', 'button', 'input', 'nav', 'footer', 'aside', 'form',
  'video', 'audio', 'object', 'embed',
]);

/** 视为块级的 display 值。 */
const BLOCK_DISPLAYS = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'flow-root']);
/** 视为块级的标签名（display 被改成 inline 时仍按契约算块级）。 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'blockquote', 'pre', 'td', 'th', 'figure', 'figcaption',
  'ul', 'ol', 'dl', 'dt', 'dd', 'main', 'aside', 'nav', 'form', 'address',
]);

const EMPTY_STYLE = Object.freeze({});
const RESULT_NONE = Object.freeze({ hasText: false, hasBlock: false });
const RESULT_BLOCK = Object.freeze({ hasText: false, hasBlock: true });
const MAX_BR_NODES = 4000;
const MAX_TEXT_NODES = 20000;

/** 计算块文本时要排除的子树（不可见/非正文内容绝不进入 `text`）。 */
const TEXT_SKIP_TAGS = new Set([...NEVER_TRAVERSE, ...SKIP_EMIT]);
/** 一次性探测「块内是否存在需要排除的子树」。 */
const TEXT_SKIP_SELECTOR = `${[...TEXT_SKIP_TAGS].join(',')},[hidden],[aria-hidden="true"]`;

/**
 * @param {Element} el 元素。
 * @returns {string} 小写标签名（非元素返回 ''）。
 */
function tagOf(el) {
  if (!el || el.nodeType !== 1) return '';
  const name = el.tagName ?? el.nodeName ?? '';
  return typeof name === 'string' ? name.toLowerCase() : '';
}

/**
 * @param {Node} node 节点。
 * @returns {string} 折叠空白后的文本（`'  a\n b '` → `'a b'`）。
 */
function collapseWs(node) {
  const raw = node && typeof node.textContent === 'string' ? node.textContent : '';
  return collapseText(raw);
}

/**
 * @param {unknown} value 任意文本。
 * @returns {string} 折叠空白后的文本。
 */
function collapseText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 收集子树中真正会显示出来的文本（跳过 script/style/nav/隐藏节点等）。
 * @param {Node} node 子树根。
 * @returns {string} 拼接文本。
 */
function collectVisibleText(node) {
  const parts = [];
  let visited = 0;
  /** @param {Node} current 当前节点。 */
  const walk = (current) => {
    const kids = current ? current.childNodes : null;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      if (visited++ > MAX_TEXT_NODES) return;
      const child = kids[i];
      const nt = child.nodeType;
      if (nt === 3) {
        parts.push(typeof child.nodeValue === 'string' ? child.nodeValue : (child.textContent ?? ''));
        continue;
      }
      if (nt !== 1) continue;
      const tag = tagOf(child);
      if (TEXT_SKIP_TAGS.has(tag) || isHiddenAttr(child) || isAriaHidden(child)) continue;
      walk(child);
    }
  };
  try {
    walk(node);
  } catch {
    return node && typeof node.textContent === 'string' ? node.textContent : '';
  }
  return parts.join('');
}

/**
 * 块文本：正常情况下与 `el.textContent` 折叠结果完全一致；
 * 仅当块内含有 script/style/nav/隐藏节点时才做过滤，避免把脚本源码写进正文
 * （core/render.js 用 `block.text` 渲染段落，因此这里必须给「可见文本」）。
 * @param {Element} el 块元素。
 * @returns {string} 折叠空白后的可见文本。
 */
function visibleTextOf(el) {
  try {
    if (typeof el.querySelector === 'function' && !el.querySelector(TEXT_SKIP_SELECTOR)) {
      return collapseWs(el);
    }
  } catch {
    /* 探测失败时走过滤路径 */
  }
  return collapseText(collectVisibleText(el));
}

/**
 * @param {Element} el 元素。
 * @returns {boolean} 是否带 `hidden` 属性。
 */
function isHiddenAttr(el) {
  try {
    if (el.hasAttribute) return el.hasAttribute('hidden') === true;
    return el.getAttribute && el.getAttribute('hidden') !== null;
  } catch {
    return false;
  }
}

/**
 * @param {Element} el 元素。
 * @returns {boolean} 是否 `aria-hidden="true"`。
 */
function isAriaHidden(el) {
  try {
    const v = el.getAttribute ? el.getAttribute('aria-hidden') : null;
    return typeof v === 'string' && v.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/**
 * 判断元素是否块级（display 命中块级值，或标签名在白名单内）。
 * @param {Element} el 元素。
 * @param {CSSStyleDeclaration|Object} [cs] 已取得的计算样式。
 * @returns {boolean} 是否块级。
 */
export function isBlockLevel(el, cs) {
  if (!el || el.nodeType !== 1) return false;
  let display = '';
  try {
    const style = cs ?? styleOf(el);
    display = style && typeof style.display === 'string' ? style.display.toLowerCase() : '';
  } catch {
    display = '';
  }
  if (display && BLOCK_DISPLAYS.has(display)) return true;
  return BLOCK_TAGS.has(tagOf(el));
}

/**
 * 取元素内由 `<br>` 分隔的各行纯文本。
 * @param {Element|null|undefined} el 块元素。
 * @returns {string[]} 行文本数组；元素内没有 `<br>` 时返回 `[]`。
 */
export function linesFromBr(el) {
  if (!el || el.nodeType !== 1) return [];
  const out = [];
  let current = [];
  let seenBr = false;
  let visited = 0;

  /** @param {Node} node 当前节点。 */
  const collect = (node) => {
    const kids = node ? node.childNodes : null;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      if (visited++ > MAX_BR_NODES) return;
      const child = kids[i];
      const nt = child.nodeType;
      if (nt === 3) {
        current.push(typeof child.nodeValue === 'string' ? child.nodeValue : (child.textContent ?? ''));
        continue;
      }
      if (nt !== 1) continue;
      const tag = tagOf(child);
      if (tag === 'br') {
        seenBr = true;
        out.push(current.join(''));
        current = [];
        continue;
      }
      if (NEVER_TRAVERSE.has(tag) || SKIP_EMIT.has(tag)) continue;
      collect(child);
    }
  };

  try {
    collect(el);
  } catch {
    return [];
  }
  if (!seenBr) return [];
  out.push(current.join(''));
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0);
}

/**
 * 由标签与祖先关系推导块类型（heading 由 core/classify.js 判定，此处不产出）。
 * @param {string} tag 小写标签名。
 * @param {boolean} inPre 是否位于 `<pre>` 内。
 * @returns {'para'|'li'|'quote'|'code'|'table'|'figure'|'hr'} 块类型。
 */
function typeForTag(tag, inPre) {
  if (tag === 'hr') return 'hr';
  if (inPre || tag === 'pre') return 'code';
  if (tag === 'table' || tag === 'td' || tag === 'th' || tag === 'tr') return 'table';
  if (tag === 'figure' || tag === 'figcaption') return 'figure';
  if (tag === 'blockquote') return 'quote';
  if (tag === 'li') return 'li';
  return 'para';
}

/**
 * 解析 font-weight：数字直取，`bold`→700，`normal`→400。
 * @param {CSSStyleDeclaration|Object} cs 计算样式。
 * @returns {number} 100..900 之间的数值。
 */
function weightOf(cs) {
  const raw = cs && cs.fontWeight !== undefined && cs.fontWeight !== null ? String(cs.fontWeight).trim().toLowerCase() : '';
  if (raw === 'bold' || raw === 'bolder') return 700;
  if (raw === 'normal' || raw === 'lighter' || raw === '') return 400;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n) : 400;
}

/**
 * 构建单个 IR 块。
 * @param {Element} el 块元素。
 * @param {Object} cs 计算样式。
 * @param {string} tag 小写标签名。
 * @param {boolean} inPre 是否位于 `<pre>` 内。
 * @param {Document} doc 文档（供 sanitizeInline 使用）。
 * @returns {Object} IrBlock。
 */
function buildBlock(el, cs, tag, inPre, doc) {
  const text = visibleTextOf(el);
  const fontSizeRaw = px(cs ? cs.fontSize : null, 0);
  const fontSize = fontSizeRaw > 0 ? fontSizeRaw : 16;
  const fontWeight = weightOf(cs);
  const lh = lineHeightPx(cs, fontSize);
  const textAlign = cs && typeof cs.textAlign === 'string' ? cs.textAlign.toLowerCase() : '';
  const textTransform = cs && typeof cs.textTransform === 'string' ? cs.textTransform.toLowerCase() : '';
  const letters = (text.match(/\p{L}/gu) || []).length;
  const lowerLetters = (text.match(/\p{Ll}/gu) || []).length;

  /** @type {Object} */
  const block = {
    type: typeForTag(tag, inPre),
    html: sanitizeHtml(el, doc, text),
    text,
    fontSize,
    fontWeight,
    lineHeightPx: lh,
    centered: textAlign === 'center' || textAlign === 'justify-center' || textAlign === '-webkit-center',
    allCaps: textTransform === 'uppercase' || (letters >= 3 && lowerLetters === 0),
    bold: fontWeight >= 600,
    kind: tag,
  };

  // Sites often use marker-free li elements purely as paragraph/layout wrappers.
  // Preserve actual points, but do not introduce bullets that were absent in the source.
  if (block.type === 'li') {
    const marker = cs?.listStyleType;
    const image = cs?.listStyleImage;
    const markerHidden = marker === 'none' && (!image || image === 'none');
    if (markerHidden || (cs?.display && cs.display !== 'list-item')) block.type = 'para';
    else {
      const parent = el.parentElement;
      block.listKind = parent?.tagName?.toLowerCase() === 'ol' ? 'ol' : 'ul';
      block.listId = parent ? cssPath(parent) : '';
      if (block.listKind === 'ol' && parent) {
        const items = Array.from(parent.children).filter(child => child.tagName?.toLowerCase() === 'li');
        const reversed = parent.hasAttribute('reversed');
        let number = parent.hasAttribute('start') ? Number(parent.getAttribute('start')) : reversed ? items.length : 1;
        for (const item of items) {
          if (item.hasAttribute('value')) number = Number(item.getAttribute('value'));
          if (item === el) break;
          number += reversed ? -1 : 1;
        }
        block.listValue = Number.isFinite(number) ? number : 1;
        block.listReversed = reversed;
      }
    }
  }

  if (/^h[1-6]$/.test(tag)) block.nativeLevel = Number(tag.charAt(1));

  const lines = linesFromBr(el);
  if (lines.length > 0) block.lines = lines;

  // 行内结构：render.js 只接受原子数据（它不解析 HTML），所以由本层（唯一懂真实 DOM 的
  // 一层）把净化后的行内子树拍平成 InlineNode[]。失败时 render.js 自动退回 block.text。
  try {
    const inline = inlineNodes(el, { doc });
    if (Array.isArray(inline) && inline.length > 0) block.inline = inline;
  } catch {
    /* 行内结构失败不影响块本身 */
  }

  const rect = rectOf(el);
  if (rect) {
    block.rect = rect;
    block.top = rect.y;
  }

  try {
    const path = cssPath(el);
    if (typeof path === 'string' && path) block.srcPath = path;
  } catch {
    /* 路径失败不影响块本身 */
  }
  return block;
}

/**
 * 取净化后的行内 HTML；净化失败时退回转义后的纯文本。
 * @param {Element} el 块元素。
 * @param {Document} doc 文档。
 * @param {string} text 已折叠的纯文本。
 * @returns {string} 安全 HTML 字符串。
 */
function sanitizeHtml(el, doc, text) {
  try {
    const html = sanitizeInline(el, { doc });
    if (typeof html === 'string') return html;
  } catch {
    /* 落到转义文本 */
  }
  try {
    return escapeHtml(text);
  } catch {
    return '';
  }
}

/**
 * 加权众数：按累计文本长度投票，取代表值。
 * @param {Map<string, {w:number, value:number}>} map 统计表。
 * @param {number} fallback 无数据时的兜底值。
 * @returns {number} 代表值。
 */
function weightedWinner(map, fallback) {
  let bestValue = fallback;
  let bestWeight = -1;
  for (const entry of map.values()) {
    if (!Number.isFinite(entry.value)) continue;
    if (entry.w > bestWeight) {
      bestWeight = entry.w;
      bestValue = entry.value;
    }
  }
  return Number.isFinite(bestValue) ? bestValue : fallback;
}

/**
 * @param {Map<string, {w:number, value:number}>} map 统计表。
 * @param {number} value 样本值。
 * @param {number} weight 权重。
 */
function addSample(map, value, weight) {
  if (!Number.isFinite(value)) return;
  const key = value.toFixed(2);
  const found = map.get(key);
  if (found) found.w += weight;
  else map.set(key, { w: weight, value });
}

/**
 * 计算正文基线：字号/行高按文本长度加权取众数，medianLength 取段落中位数。
 * @param {Object[]} blocks 已收集的块。
 * @returns {{fontSize:number,lineHeightPx:number,medianLength:number}} 正文基线。
 */
function computeBody(blocks) {
  const sizeMap = new Map();
  const lhMap = new Map();
  const paraLengths = [];
  const allLengths = [];
  for (const b of blocks) {
    if (!b) continue;
    const len = typeof b.text === 'string' ? b.text.length : 0;
    const w = len > 0 ? len : 1;
    addSample(sizeMap, b.fontSize, w);
    addSample(lhMap, b.lineHeightPx, w);
    allLengths.push(len);
    if (b.type === 'para') paraLengths.push(len);
  }
  const fontSize = weightedWinner(sizeMap, 16);
  const lh = weightedWinner(lhMap, fontSize * 1.2);
  const lengths = paraLengths.length > 0 ? paraLengths : allLengths;
  return { fontSize, lineHeightPx: lh, medianLength: median(lengths) };
}

/**
 * @param {number[]} values 数字数组（会被复制排序）。
 * @returns {number} 中位数，空数组返回 0。
 */
function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 递归遍历子树，产出叶子块。
 * @param {Element} el 当前元素。
 * @param {Object} cs 当前元素的计算样式（已取得，不复用）。
 * @param {boolean} inPre 是否位于 `<pre>` 内。
 * @param {Object} ctx 遍历上下文 `{ doc, blocks, state, maxBlocks }`。
 * @returns {{hasText:boolean, hasBlock:boolean}} 子树统计。
 */
function walkElement(el, cs, inPre, ctx) {
  const tag = tagOf(el);
  const inPreNow = inPre || tag === 'pre';
  const childrenStart = ctx.blocks.length;

  if (NEVER_TRAVERSE.has(tag) || isHiddenAttr(el) || isAriaHidden(el)) return RESULT_NONE;

  if (SKIP_EMIT.has(tag)) {
    // 自身永不产出块；但「可见且块级」的跳过区（nav/footer/aside…）
    // 会阻断祖先，避免把导航文本当成正文段落。
    let blocking = false;
    try {
      blocking = isVisible(el, cs) && isBlockLevel(el, cs);
    } catch {
      blocking = false;
    }
    return blocking ? RESULT_BLOCK : RESULT_NONE;
  }

  let hasText = false;
  let hasBlock = false;
  const kids = el.childNodes;
  if (kids) {
    for (let i = 0; i < kids.length; i++) {
      if (ctx.state.done) break;
      const child = kids[i];
      const nt = child.nodeType;
      if (nt === 3) {
        if (!hasText) {
          const value = typeof child.nodeValue === 'string' ? child.nodeValue : (child.textContent ?? '');
          if (/\S/.test(value)) hasText = true;
        }
        continue;
      }
      if (nt !== 1) continue;
      const childTag = tagOf(child);
      if (NEVER_TRAVERSE.has(childTag) || isHiddenAttr(child) || isAriaHidden(child)) continue;
      let childCs = EMPTY_STYLE;
      try {
        childCs = styleOf(child);
      } catch {
        childCs = EMPTY_STYLE;
      }
      const res = walkElement(child, childCs, inPreNow, ctx);
      if (res.hasText) hasText = true;
      if (res.hasBlock) hasBlock = true;
    }
  }

  // A real list item may contain paragraph elements. Keep those paragraphs within
  // one point, while marker-free li layout wrappers remain ordinary paragraphs.
  if (tag === 'li' && hasBlock && !ctx.state.done && !el.querySelector?.('ul, ol')) {
    const children = ctx.blocks.slice(childrenStart);
    const listBlock = buildBlock(el, cs, tag, inPre, ctx.doc);
    if (listBlock.type === 'li' && children.length &&
        listBlock.text.replace(/\s/g, '') === children.map(child => child.text).join('').replace(/\s/g, '')) {
      listBlock.inline = children.flatMap((child, index) => [
        ...(index ? [{ type: 'break' }] : []),
        ...(child.inline || [{ type: 'text', text: child.text }]),
      ]);
      ctx.blocks.splice(childrenStart, children.length, listBlock);
    }
  }

  // 达到块上限：立刻停止向上继续产出。
  if (ctx.state.done) return { hasText, hasBlock: true };

  let qualifies = false;
  if (!hasBlock && (hasText || tag === 'hr')) {
    try {
      qualifies = isVisible(el, cs) && isBlockLevel(el, cs);
    } catch {
      qualifies = false;
    }
  }
  if (qualifies) {
    try {
      const block = buildBlock(el, cs, tag, inPre, ctx.doc);
      if (block && typeof block.text === 'string') ctx.blocks.push(block);
    } catch {
      /* 单块失败只跳过该块 */
    }
    if (ctx.blocks.length >= ctx.maxBlocks) {
      ctx.state.done = true;
      ctx.state.truncated = true;
    }
  }
  if (ctx.state.done) {
    return { hasText, hasBlock: true };
  }
  return { hasText, hasBlock: hasBlock || qualifies };
}

/**
 * 把 DOM 子树编译为 IR 文档。
 * @param {Element|Document} root 提取根（通常是 Element）。
 * @param {{doc?: Document, maxBlocks?: number}} [opts] 选项。
 * @returns {{blocks:Object[], body:{fontSize:number,lineHeightPx:number,medianLength:number}, title:string, srcPath:string, truncated:boolean}} IrDoc。
 */
export function scanDocument(root, opts = {}) {
  const doc = opts.doc ?? (root && root.ownerDocument) ?? getDoc();
  const requested = Number.isFinite(opts.maxBlocks) ? Math.floor(Number(opts.maxBlocks)) : MAX_BLOCKS;
  const maxBlocks = requested > 0 ? requested : MAX_BLOCKS;
  const blocks = [];
  const state = { done: false, truncated: false };
  const ctx = { doc, blocks, state, maxBlocks };
  const title = doc && typeof doc.title === 'string' ? doc.title : '';

  let target = root ?? null;
  if (target && target.nodeType === 9) target = target.documentElement ?? target.body ?? null;

  let srcPath = '';
  if (target && target.nodeType === 1) {
    try {
      const p = cssPath(target);
      if (typeof p === 'string' && p) srcPath = p;
    } catch {
      srcPath = '';
    }
    if (!srcPath) srcPath = tagOf(target);
    try {
      walkElement(target, styleOf(target), false, ctx);
    } catch {
      /* 极端畸形页面：返回已收集的部分结果 */
    }
  }

  return { blocks, body: computeBody(blocks), title, srcPath, truncated: state.truncated };
}
