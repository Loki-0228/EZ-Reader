# EZ-Reader 内部契约（所有实现必须严格遵守）

本文件是 `src/core`、`src/dom`、`src/ui`、`tools` 之间的唯一接口约定。
任何模块都不得自行发明字段名或函数名。

## 0. 运行时约束

- 零第三方运行库依赖。阅读、字体与排版本地完成；用户发起划词、全文翻译或开启划词预加载后，后台访问所选的 MyMemory / DeepSeek 接口，词语讲解按设置查询词典或 AI。只用 Node 24 标准库与浏览器原生 API。
- 源码为 **ESM**（`export` / `import`）。内容脚本无法原生 `import`，由 `tools/build.js`
  做「去 import/export + IIFE + 命名空间」的最小变换。因此：
  - 模块之间**只允许** `import { name } from './other.js'` 形式（具名导入，相对路径，必须带 `.js`）。
  - 禁止默认导出、禁止 `export *`、禁止动态 `import()`、禁止裸模块名。
- 语言级别：ES2022（可用可选链、空值合并、`??=`、`Object.hasOwn`）。
- 不用 TypeScript。用 JSDoc 注释标注类型。

## 1. 中间表示（IR）

`dom/scan.js` 把真实 DOM 编译成 IR；`core/*` 只吃 IR，因此完全可脱离浏览器单测。

```js
/** @typedef {Object} IrBlock
 * @property {'heading'|'para'|'li'|'quote'|'code'|'table'|'figure'|'hr'} type
 * @property {number}   [level]      // 仅 heading：1..6
 * @property {string}   html         // 净化后的行内 HTML（已 escape 文本、已过滤属性）
 * @property {string}   text         // 纯文本，用于分词/长度判断，绝不用于 innerHTML
 * @property {number}   fontSize     // px
 * @property {number}   fontWeight   // 100..900
 * @property {number}   lineHeightPx // px
 * @property {boolean}  [centered]
 * @property {boolean}  [allCaps]
 * @property {boolean}  [bold]
 * @property {number}   [nativeLevel]  // 原生 h1..h6 标签带来的层级提示
 * @property {string[]} [lines]        // 由 <br> 分行得到的纯文本行
 * @property {number}   [top]          // 页面坐标，仅用于排序
 * @property {Object}   [rect]         // {x,y,width,height}
 * @property {string}   [srcPath]      // 源节点稳定路径，用于重建/回链
 * @property {string}   [kind]         // 'p'|'div'|'li'|'td'|... 源标签名小写
 * @property {InlineNode[]} [inline]   // 行内结构（见下方 InlineNode）；render.js 优先消费它
 * @property {'ul'|'ol'} [listKind]    // 真正显示标记的列表项
 * @property {string} [listId]         // 原列表路径，连续同列表的项合并渲染
 * @property {number} [listValue]      // 有序列表原编号，保留 start/value/reversed
 * @property {boolean} [listReversed]
 */

/** @typedef {Object} InlineNode  行内结构（原子，可直接创建 DOM）
 * @property {'text'|'element'|'image'|'break'} type
 * @property {string}   [text]                  type='text'
 * @property {string}   [tag]                   type='element'，白名单标签：strong,b,i,em,u,s,del,ins,mark,sub,sup,small,abbr,span,code,kbd,samp,var
 * @property {Object<string,string>} [attrs]    type='element'，仅 title（a 额外允许 href，且必须为绝对 http/https 地址）
 * @property {InlineNode[]} [children]          type='element'
 * @property {string}   [alt]                   type='image'：图片的 alt 文本，渲染为 .ezr-alt 占位
 * @property {string}   [src]                   type='image'：可选的原始地址，仅存入 data-ezr-src，绝不加载
 */

/** @typedef {Object} IrDoc
 * @property {IrBlock[]} blocks
 * @property {{fontSize:number,lineHeightPx:number,medianLength:number}} body  // 正文基线
 * @property {string} title
 * @property {string} [srcPath]   // 提取根路径
 * @property {boolean} truncated  // 是否因 20000 块上限被截断
 */
```

## 2. `src/core/constants.js`

```js
export const BLOCK_TYPES = Object.freeze(['heading','para','li','quote','code','table','figure','hr']);
export const MIN_HEADING_LEVEL = 1;
export const MAX_HEADING_LEVEL = 6;
export const MAX_BLOCKS = 20000;

// 字体族：【唯一事实来源】仅系统/本机字体栈，零网络。
export const FONT_FAMILIES = Object.freeze([
  { id: 'serif-georgia',  label: 'Georgia（衬线，推荐）', stack: "Georgia, 'Iowan Old Style', 'Times New Roman', serif" },
  { id: 'serif-charter',  label: 'Charter / 宋体衬线',     stack: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif" },
  { id: 'serif-palatino', label: 'Palatino（宽衬线）',     stack: "'Palatino Linotype', 'Book Antiqua', Palatino, 'Source Han Serif SC', 'Songti SC', serif" },
  { id: 'sans-verdana',   label: 'Verdana（大字面）',      stack: "Verdana, Geneva, Tahoma, 'Microsoft YaHei', sans-serif" },
  { id: 'sans-segoe',     label: 'Segoe UI / 系统无衬线',  stack: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Microsoft YaHei', sans-serif" },
  { id: 'mono-consolas',  label: 'Consolas（等宽）',       stack: "Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', 'Courier New', monospace" },
]);

export const HEADING_FONT_SIZES = Object.freeze([30, 25, 21, 18, 17, 16]); // h1..h6，px

export const DEFAULT_SETTINGS = Object.freeze({
  // 排版
  fontId: 'serif-georgia',
  bodyFontSize: 16,        // px, 14..24
  lineHeight: 1.6,         // 无单位倍率, 1.2..2.2
  gapFactor: 1.6,          // 段间距 = gapFactor × 行高
  gapExtraPx: 2,           // 额外像素，保证严格大于 1.5L
  gapOverridePx: null,     // null = 用公式；数字 = 手动固定段间距
  measure: 44,             // rem 列宽, 24..90
  // 内容
  headingMode: 'standard', // 'conservative' | 'standard' | 'aggressive'
  splitLines: true,
  // 大小写
  capitalizeFirst: false,  // 每个单词首字母大写
  capitalizeLocales: '',   // 保留字段，暂不使用
  // 缩放
  zoomMode: 'fit-width',   // 'fit-width' | 'fit-page' | 'manual'
  zoom: 1,                 // manual 时的倍率, 0.6..2.5
  // 外观
  theme: 'light',          // 'light' | 'sepia' | 'dark' | 'auto'
  showOutline: false,
  toolbarDock: 'top',      // 'top' | 'bottom'：工具栏所停靠的窗口边缘
  // 行为
  rememberPerSite: true,
  restorePosition: true,
});

export const SETTING_LIMITS = Object.freeze({
  bodyFontSize: { min: 14, max: 24 },
  lineHeight:   { min: 1.2, max: 2.2 },
  gapFactor:    { min: 1.15, max: 3 },
  gapExtraPx:   { min: 0, max: 24 },
  measure:      { min: 24, max: 90 },
  zoom:         { min: 0.6, max: 2.5 },
});

export const NEGATIVE_HINT_RE = /(^|[^a-z])(nav|menu|sidebar|side-bar|comment|footer|share|social|related|promo|advert|ads?|cookie|breadcrumb|masthead|banner|toolbar|skip)([^a-z]|$)/i;
export const POSITIVE_HINT_RE = /(^|[^a-z])(article|main|post|content|entry|story|body|markdown|prose)([^a-z]|$)/i;

// 放在这里，供全工程复用（避免重复实现，消除 HTML 注入面）
export function escapeHtml(s) { /* & < > " ' */ }
export function clamp(n, min, max) { /* 非有限数返回 min */ }
```

## 3. `src/core/settings.js`

```js
export function normalizeSettings(raw)            // 逐字段校验+clamp，未知字段忽略，返回完整对象（绝不返回 null）
export function mergeSettings(base, override)     // 浅合并一级对象
export function resolveSettings(defaults, byOrigin, origin)
//   rememberPerSite 为 true 时用 byOrigin[origin] 覆盖 defaults，否则直接用 defaults
export function isCjkDominant(text)               // 中日韩字符占比 > 30%
export function fontStackById(id)                 // 未知 id 回退第一个字体族的 stack
export function storageKeyFor(origin, kind)       // kind: 'settings'|'pos'
```

## 4. `src/core/paragraph-gap.js`

```js
// 唯一真实来源。不变量：gapPx >= 1.5 * lineHeightPx，且随 lineHeightPx 单调不减。
export function paragraphGapPx({ lineHeightPx, gapFactor, gapExtraPx, gapOverridePx })
// gapOverridePx 为有限数时返回 max(override, 1.5*lineHeightPx)，否则：
//   base = gapFactor * lineHeightPx
//   extra = max(gapExtraPx, lineHeightPx * 0.05)
//   return base + extra
```

## 5. `src/core/heading-levels.js`

```js
export function clusterFontSizes(sizes, tolerance = 0.5)  // → [{fontSize, count}]，按 fontSize 降序
export function assignHeadingLevels(blocks)               // 原地不修改；返回新数组，为 heading 块填 level 1..6
// 规则：按 fontSize 降序聚类（同簇容差 0.5px）→ 簇序号即层级；
//       nativeLevel 仅用于同簇内 tie-break 排序；
//       只有 1 个簇时全部降级为 level 2（避免满屏巨型标题）。
```

## 6. `src/core/classify.js`

```js
export function classifyBlock(block, context)
// context = { bodyFontSize, bodyLineHeightPx, mode: 'conservative'|'standard'|'aggressive' }
// 返回新的部分字段：{ type, level?, bold?, allCaps?, centered? }
// 不可变：不得修改传入的 block。
// 判级信号（mode 控制阈值）：
//   conservative: 仅原生 heading 标签 / role=heading
//   standard:     原生标签；或 fontSize>=1.15*body 且 (bold|centered|allCaps) 且 text.length<=120；
//                 或 fontSize>=1.6*body；或 allCaps 且 text.length<=80
//   aggressive:   在 standard 基础上再接受「独立成段的加粗短行(<=80)」与「<br> 分隔的粗体短行」
export function isChromeBlock(block, context)  // nav/页脚/分享/相关阅读等噪声 → true
```

## 7. `src/core/split.js`

```js
export function isContinuationLine(prev, next)  // 前一行以字母/连字符/逗号结尾且下一行以小写字母开头 → true
export function splitBlock(block)               // → IrBlock[]（列表/代码/引用/表格不拆点；普通段落按 br 拆分并保留对应行内结构）
export function splitAll(blocks)                // → IrBlock[]
```

## 8. `src/core/title-case.js`

```js
export function toTitleCase(text)  // 不修改、不加标记
// 规则：用 /\p{L}[\p{L}\p{N}'’-]*/gu 分词，仅把每个词的**首字符** toUpperCase()，
//       其余字符保持原样（iPhone / DNA 不被破坏）；不处理纯数字词。
export function segmentForCapitalize(text)
// → [{ text: string, word: boolean, skip?: boolean }]，相邻同类已合并，拼接后必须完全等于原文。
//   word=true 且 skip 不为 true 的片段，其首字符大写即为目标效果。
//   skip=true 用于：URL（含 '://' 或 以 www. 开头）、邮箱、纯数字、长度为 1 的孤字符。
//   必须使用无 locale 的 toUpperCase()（规避土耳其语 i/İ 问题）。

export function segmentRanges(text)
// 位置版分词：→ [{ start, end, word, skip }]，**不合并**相邻同类，
// 相邻区间首尾相接且完整覆盖输入（ranges[i].end === ranges[i+1].start，末项 end === text.length）。
// render.js 用它为每个可大写词生成 span[data-ezr-w]，配合
// `[data-ezr-w]::first-letter { text-transform: uppercase }` 得到视觉大写，
// 而 DOM 中的文本始终保持原样（复制/查找/无障碍读到的都是原文）。
```

## 9. `src/core/score.js`

```js
export function scoreCandidate(stats)
// stats = { paraCount, textLength, linkTextLength, className, id, tagName }
// 返回数字得分；链接密度 > 0.5 的候选必须为负分。
// score = paraCount*1 + min(textLength,5000)/100 - linkRatio*8 + 命中 POSITIVE_HINT_RE ? 3 : 0
//         - 命中 NEGATIVE_HINT_RE ? 6 : 0
export function pickBest(candidates)  // candidates: [{stats, depth, path}] → 最高分；平分取 depth 最小
```

## 10. `src/core/sanitize.js`

```js
// 必须支持注入 DOM 实现以便单测：
export function sanitizeInline(node, opts)
// opts = { doc?: Document, dropUrlText?: boolean }
// doc 缺省时用 globalThis.document；两者都无则抛 Error('sanitizeInline: no document')。
//
// 白名单：strong,b,i,em,u,s,del,ins,mark,sub,sup,small,abbr,span,code,kbd,samp,var,br
// allowedAttrs: { a: ['href','title'], abbr: ['title'], span: [], code: [] }
// 文本节点必须 escapeHtml。剥掉 on* 事件属性、style、class、id、data-*。
// <a href> 以 javascript:/data:/vbscript: 开头（大小写与空白不敏感）→ 降级为纯文本。
// 其它非白名单元素（含 svg/script/style/iframe）→ 丢弃标签，保留其子节点文本（script/style 整体丢弃）。
// href 必须解析为绝对地址（stub 环境无法解析时保留原值）。
// 返回 HTML 字符串。
export function sanitizeAll(root, opts)  // 便捷封装：对整个子树调用
```

**DOM stub 约定（单测用）**：实现只允许使用
`nodeType`（1/3）、`nodeName`（大写）、`childNodes`、`textContent`、`getAttribute(name)`、
`setAttribute(name, value)`、`cloneNode(deep)`、`querySelectorAll`（可不用）。
其中 `nodeType === 3` 时通过 `textContent` 取文本。不得调用 `outerHTML`/`innerHTML`/`classList`/`style`。

## 11. `src/core/selector.js`

```js
export function cssPath(el, stopAt)   // el: {id?, tagName, parentElement} → 稳定 CSS 路径；优先 #id
export function isValidPath(path)     // 非空字符串且不含换行
```

## 12. `src/core/render.js`

```js
// 入参为已判级的 IrDoc；返回一个 DocumentFragment（opts.doc 提供）。
export function renderDoc(irDoc, settings, opts)
// opts = { doc: Document }
// 输出结构：
//   div.ezr-article
//     ├─ h1.ezr-h1 .. h6.ezr-h6          文本走 titleCase（若开启）
//     ├─ p.ezr-para                       文本走 titleCase（若开启）
//     ├─ ul.ezr-list > li.ezr-li
//     ├─ blockquote.ezr-quote
//     ├─ pre.ezr-code > code
//     ├─ div.ezr-table-wrap > table
//     └─ hr.ezr-hr
// 每个块根元素带 data-ezr-type / data-ezr-level（有层级时）/ data-ezr-id（块序号）。
// 段落/标题文本节点必须经 segmentForCapitalize 切分后逐段写入，
// 使开启大小写时只有词首片段被替换；跳过片段原样写入。
export function blocksToOutline(irDoc)  // → [{ id, level, text }]，仅 heading 块
```

## 13. `src/core/styles.js`

```js
export const CSS_VARS = Object.freeze(['--ezr-font','--ezr-size-body','--ezr-size-h1','--ezr-size-h2','--ezr-size-h3','--ezr-size-h4','--ezr-size-h5','--ezr-size-h6','--ezr-lh','--ezr-gap','--ezr-measure','--ezr-scale','--ezr-fg','--ezr-bg','--ezr-muted','--ezr-border']);
export function readerCss()   // 返回 Shadow DOM 内 <style> 的完整 CSS 字符串
export function cssVarsFor(settings)
// → { '--ezr-font': fontStackById(...), '--ezr-size-body': '16px', '--ezr-lh': '1.6',
//     '--ezr-gap': '<paragraphGapPx(settings,16)>px', '--ezr-measure': '44rem',
//     '--ezr-scale': '1', '--ezr-size-h1'...: '30px' ... }
// 全部为字符串值，键含 '--' 前缀。
```

**样式隔离硬性要求**（`readerCss()` 内必须包含）：
- `:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; }`
- `.ezr-root { line-height: normal; letter-spacing: normal; word-spacing: normal; text-transform: none; font-variant: normal; text-align: left; }`
- `@media print { .ezr-toolbar, .ezr-outline { display: none !important } }`
- 不得出现任何远程 `url(...)`/`@import`/`@font-face` 网络引用。
- `--ezr-scale` 用于 `.ezr-article { zoom: var(--ezr-scale) }` 或等价的 transform。
- 工具栏“适配”切换到 `fit-width`：按阅读窗口可用宽度与设计列宽之比计算缩放倍率，支持宽屏放大，范围为 0.6–2.5；显示的百分比必须与实际文字缩放保持同步。正文保留内边距；当倍率未达到上限时，正文列宽应等于窗口可用宽度。
- 工具栏的停靠边由宿主 `#ezr-root` 上的 `data-ezr-dock`（`'top'` / `'bottom'`）决定。取值为 `bottom` 时，`:host` 必须锚定到窗口底部（`:host([data-ezr-original][data-ezr-dock="bottom"]) { top: auto !important; bottom: 0 !important; }`），工具栏分隔线翻至上侧，`.ezr-toolbar-host` 的阴影翻向上方。

## 14. 存储契约（`chrome.storage.local`）

| key | 值 |
|---|---|
| `ezr:settings:default` | 完整 settings 对象 |
| `ezr:settings:byOrigin` | `{ [origin]: Partial<Settings> }` |
| `ezr:pos` | `{ [url]: { scrollY: number, blockId: number, srcPath: string \| null, ts: number } }` |

## 15. 测试约定

- `test/*.test.js`，用 `node:test` + `node:assert/strict`，运行 `node tools/run-tests.js`（进程内执行，兼容 Windows 沙箱）。
- 单测**不得**依赖浏览器；需要 DOM 的用最小 stub（见 §10）。
- 每个 `src/core/*.js` 至少一个对应测试文件。

## 16. 划词翻译契约

- `src/ui/translation.js` 在阅读视图及显式开启的原网页中捕获选区、展示纯文本结果；原网页模式不生成卡片。默认点击才请求，开启 `preload` 后选区稳定 450ms 自动调用所选 `provider`。拖选过程中不预加载，隐藏/换选区取消未发出请求，旧请求结果不得生成卡片或保存。
- `src/translation/background.js` 在 MV3 后台注册 `ezr:translation:*` 消息，原后台消息桥必须跳过该命名空间。可信来源取自 Chrome `sender`，不可由消息伪造标签页或网页地址。
- `config` 返回 `{ ok, config: { enabled, source, target, model, provider, preload, explanations, wordCards, autoSave, level }, hasKey }`；`options` 打开扩展设置页；`save` 与 `clear-all` 仅允许扩展 options 页调用。`preferences` 只接受 enabled/source/target/model/provider/preload/explanations/wordCards/autoSave/level 白名单字段，不允许修改密钥；语义配置变更仍清除旧语境。
- `run` 输入 `{ provider: 'free'|'deepseek', text, nearby, view: { id, title, context, language } }`；成功返回 `{ ok: true, text, provider, target, cached?, contextReused? }`，失败返回 `{ ok: false, message }`。一次选文不超过 2000 字符。
- `clear` 只清除消息发送者对应标签页/框架的语境。导航、关闭阅读、重新选区、修改语言/模型/密钥使旧语境失效。每次请求通过文档、URL、阅读区域与语义配置指纹复核隔离；切换服务偏好、自动开关与学习水平可复用摘要。
- 公共翻译配置写入 `chrome.storage.local['ezr:translation:config']`。API Key 仅保存于扩展源的 IndexedDB `ezr-private/credentials`，只由后台读取，不进入公共配置、页面 DOM、日志或响应消息。
- 简短语境摘要保存于 `chrome.storage.session['ezr:translation:context:<tabId>:<frameId>']`，原始文章与密钥不进入此缓存。最多 16 个语境，每个最多 48 个内存译文，30 分钟闲置失效。
- 语境分析和翻译提示词独立维护在 `src/translation/prompts.js`。先分析有限文章节选，再以摘要与当前选文翻译；不积累聊天历史，不执行网页中的指令。
- 构建时复制 `translation/*.js`、`pages/translation-options.js` 与 `pages/wordbook.js`。后台模块不包含在内容脚本 bundle 中；纯配置、卡片 schema、导出函数可被阅读 UI 引用。

## 17. 词语卡片与生词本

- `learn` 独立于 `run` 翻译调用；只处理最多 64 字符、5 个词的词语/短语，中文等文字最多 16 字符。纯翻译提示词仍然只输出译文。
- 免费扩展读取英文 Free Dictionary API，6 秒超时或未收录时尝试 Wiktionary，备用请求上限 12 秒。词典文本按相邻段落匹配一个释义，保留真实例句和许可；无例句/音标时不编造。
- AI 卡片复用同一个受页面隔离的语境摘要，使用独立 JSON 提示词，只包含简短释义、用法、例句；失败允许重试。所有远端内容在 UI 中使用 textContent，Anki 导出转义 HTML。
- 词语扩展和译文共用每语境 48 条缓存上限、取消信号和失效规则。任何词典或 AI 扩展失败都不应清掉已完成的译文。
- `word-card.js` 规范化卡片字段并提供双字段 Anki TXT / 通用 TSV；来源 URL 仅允许 HTTP(S)，各文本字段有长度上限。
- `chrome.storage.local['ezr:wordbook']` 最多 500 张。按 NFKC 小写词语、原文语言、目标语言去重更新；串行化增删，防止不同标签页同时保存丢卡。
- `cards-save` 只接受阅读页面调用，地址来自 Chrome sender。`cards-list` 与 `cards-remove` 只接受扩展设置页；API Key 不进入卡片和导出文件。
- 导出由用户点击触发本地文件下载，不上传到外部记忆软件，不删除本地卡片。
- 自动化拦截真实后台的远端请求以验证接口流程，使用虚拟密钥，不发送测试文章或消耗真实 DeepSeek 额度。

## 18. 独立学习开关与长文挑词

- `explanations` 控制词典/AI 讲解请求，`wordCards` 控制生成可保存、可导出的卡片，二者彼此独立。生成不等于保存；`autoSave` 默认 false，只有显式加入或另外开启自动加入才写生词本。
- 单词关闭讲解后直接由词语与译文生成基础卡片，无额外 API 调用。免费长文不调用 AI。两个学习开关都关闭时只翻译。
- `vocabulary` 仅接受 DeepSeek；输入 `text` 不超过 12000 字符，最多返回 6 词。选文翻译后可挑本段生词；本篇入口使用 `sampleContext` 的文章节选。
- `level` 为 A1/A2/B1/B2/C1/C2，默认 B1。请求携带 `learnerLevel` 与 `includeExplanation`，级别影响挑词和解释深度；只生成卡片时仅请求 term/translation，并丢弃模型多余讲解。
- `vocabulary.js` 强制词语原样出现在输入文本中，按词边界匹配、忽略大小写、去重；原句由本机提取，不能信任模型声称的原句。空结果合法。每级别/讲解模式单独缓存，共享 48 条上限。
- `cards-save-many` 原子保存最多 6 张：全部验证与容量检查成功后才写入，避免半批丢失。`automatic` 保存还必须在后台复核 enabled、wordCards 和 autoSave，防止关闭选项后晚到的请求入库。

## 19. 全文纯文本翻译

- `ezr:full-translation` 打开阅读器及内部翻译工具，不创建独立网页浮条；网站翻译只在阅读器的原网页模式中显示，返回阅读或关闭时还原网页，关闭时停止后续请求并保留缓存。`ezr:translation:full` 仅允许网页发送，使用所选 `provider`（free/deepseek）及可信 sender 文档/URL。`texts` 每批最多 8 段、合计 2400 字符，每段最多 1200；UI 默认 1000 字符切块，每次提交一个片段，串行执行，停止后不再提交下个片段。
- 全文与划词复用纯文本 `translate`，DeepSeek 仅语境分析和学习扩展要求 JSON，全文译文不要求 JSON、词元 ID 或词语对应校验。免费模式不读取 API Key、不分析 AI 语境、不调用 DeepSeek；每个 MyMemory 请求不超过 480 个 UTF-8 字节。
- `translation-text.js` 收集可见可读文本并按格式边界分为 runs，跳过阅读器的大写辅助 span 边界，将译文写回各格式内的文本节点，保留链接/强调元素及监听。不以长度比例分配译文，不保留任何语义单词映射。还原仅修改仍等于本扩展替换值的节点。双语译文使用独立纯文本 span，不能执行远端 HTML。
- `translation-order.js` 仅重排原网页全文队列：结合容器面积、可翻译文字量、链接密度和 main/article 语义，优先主体内的组，再按原序处理其余组。导航/侧栏/页脚不参与主体评分；包含相同正文的外层布局壳不重复竞争。保留全部组及 runs/chunks 的身份与内容，不改缓存键、不增加 API 请求，阅读器队列保持原顺序。
- `full-translation.js` 持有当前文档的原文快照、按 provider 隔离的纯译文缓存与请求状态。阅读器提取及区域选择期间临时恢复源文；设置重绘、双语切换、跨视图使用相同文本缓存。URL/语言/模型改变取消旧任务并清空；切换服务停止当前翻译，保留两种服务各自的缓存；停止后迟到响应只缓存，不重新替换页面。
- 后台全文缓存位于同框架 `/full` 会话，每段包括 pending Promise；全文学习使用 `/page` 会话。仅在同标签页/框架、同文档/URL/view 指纹下共享摘要；关闭阅读器不清除全文缓存。导航/语义配置改变清除所有相关会话。worker 全文内存缓存最多 3000 段，UI 文档缓存刷新即失效，不持久化原文。
- `full` 可返回 `{results, error}` 部分成功结果，首个失败中止尚未发出的批内请求，成功片段立即缓存并供 UI 使用。免费 API 小块结果也缓存，重试不会重复发送成功小块；并发完全重复的请求共享 Promise。
- 划词只处理当前显示的原文，原网页模式与阅读模式共用全局 enabled/preload/provider 设置，无独立网页划词开关。选区与任意已生成译文节点相交即拒绝，包括跨段和原译文混合选区；不显示浮层、不预加载、不反查原词。切换显示模式、重绘译文、关闭阅读器时取消待触发划词与丢弃迟到结果。选文与全文片段完全相同时可复用其译文，讲解/生词筛选独立缓存且带用户 `level`，改变水平不得触发全文重译。
- `translation-notes.js` 仅接收已有卡片，不调用翻译 API。最多显示 24 个临时批注，>=1100px 时正文左右各留 220px，窄屏只显示最近一张底部卡片。保存和 Anki 导出必须由已有的独立规则触发。

## 20. 窗口工具栏与视图可用性

- 扩展弹窗只有“打开工具栏”主操作。页面上默认挂载原网页工具栏，未点击简洁阅读前不提取正文，不自动请求翻译。空正文页面同样能使用工具栏、选区和网页翻译。
- 选区仅在原网页视图可用；缩放、字体和大纲仅在简洁阅读中可用。阅读切换与选区是一个带 role=group 的左右两段控件，窄屏不拆开换行。不可用控件使用原生 disabled 并提供 title 原因；按钮、快捷键和选区消息入口都必须遵循视图限制。大写、设置、翻译与关闭两种视图均可用。
- 设置抽屉在原网页显示通用翻译偏好、配色、大写和站点显示偏好，隐藏并禁用排版与词语学习控件。`translation-settings.js` 使用独立翻译配置协议，不把翻译偏好混入站点排版设置，不接触密钥；保存期间防止重入并同步 storage 变化，销毁后移除监听。原网页的界面重置仅恢复配色、大写和显示记忆偏好，不清除翻译设置与阅读排版。
- `original-capitalization.js` 仅在原网页且 capitalizeFirst 为 true 时调整原元素 text-transform，保留节点/文字/事件目标。保护代码、编辑区、表单等子树不继承大写；新内容批量扫描，纯 characterData 翻译写入不触发重新扫描。切换视图、选区或关闭时恢复本扩展的样式，不覆盖网页后续更新；原网页划词从 Range 的原始文字读取，不以 CSS 变换后的 Selection 字符串作为缓存键。
- `background/window-toolbar.js` 在可信后台以 `chrome.storage.session['ezr:toolbar:window:'+windowId]` 保存 enabled/revision。窗口内更新串行化，广播限定该窗口，可信 sender 决定窗口，不接受网页自报 windowId 或 tabId 越权。主框架内容脚本启动时查询；标签页激活、导航和跨窗口移动时同步；窗口关闭删除状态。保持 session 默认的可信上下文访问级别。
- 内容脚本按窗口标识与 revision 忽略过期状态，异步挂载用 lifecycle 防止关闭后被迟到初始化重新打开。换页后重建原网页工具栏；已有同页阅读视图在重复打开时保持不变。关闭工具栏同步关闭本窗口，不影响其他窗口。页面受浏览器限制无法注入时显示可操作提示。
- Esc 键优先退出划词、设置与选区状态；在简洁阅读模式下按 Esc 退回原网页，在原网页模式下则保留工具栏。只有明确关闭工具栏，才会结束窗口常驻。调试接口 open/close 用于创建与清理局部非持久会话，不改变窗口状态。
- 工具栏最右端是停靠切换按钮（`.ezr-btn-dock`），两种视图均可用，可在 `toolbarDock` 的 `top` 与 `bottom` 之间切换：设为 `bottom` 时，工具栏贴住窗口底部，原网页模式下不再遮挡页面顶部。`mount()` 中的 `setDock()` 会改写宿主属性 `data-ezr-dock`，并使 DOM 顺序与视觉顺序保持一致，正文滚动容器的引用保持不变。停靠边属于工具栏自身的属性，而非站点显示偏好，因此固定写入共享默认设置、对所有站点生效，且不写入 `byOrigin`；按钮文案、`title` 与 `aria-pressed` 均跟随当前停靠边。
