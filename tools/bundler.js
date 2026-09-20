/**
 * EZ-Reader bundler — zero dependencies.
 *
 * Extracted from build.js so it can be unit-tested: the transform is pure text
 * rewriting plus a file read, and a bug here is invisible until the extension silently
 * does nothing in a browser.
 *
 * ## Why modules are FENCED
 *
 * A Manifest V3 content script cannot use `import`, and there is no bundler available
 * offline. The obvious approach — concatenate every module into one IIFE — is wrong:
 * the modules then share a scope, so two files declaring a private `MAX_DEPTH`, or a
 * local `str`, are a fatal `SyntaxError: Identifier '…' has already been declared` at
 * parse time. The content script never runs and the browser says nothing, which looks
 * exactly like "the extension is not installed".
 *
 * So each module becomes its own function scope that returns its exports:
 *
 *     __ezr_define("src/core/render.js", function () {
 *       const { clamp } = __ezr_exports["src/core/constants.js"];
 *       …module body…
 *       return { renderDoc, blocksToOutline };
 *     });
 *
 * Consequences worth knowing:
 *   - a module body is NEVER rewritten except its import statements, so keywords and
 *     string literals are untouched (an earlier version prefixed identifiers textually
 *     and turned `const` into `__ezr_x$const`);
 *   - private names may be duplicated freely across modules;
 *   - the registry is safe because the graph is topologically ordered — a dependency is
 *     always defined before its dependents run.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export class BuildError extends Error {}

const fail = (message) => {
  throw new BuildError(message);
};

/** Character-index → 1-based line number, for actionable error messages. */
export const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const blank = (text) => text.replace(/[^\n]/g, ' ');

/* --------------------------------------------------------------- import parsing */

/**
 * Extract the local binding names from a raw import specifier list.
 * Default and namespace imports are rejected: fencing cannot give them distinct
 * semantics without extra machinery this project does not need.
 *
 * @param {string} raw specifier list, e.g. `{ a, b as c }`
 * @param {string} file module path, for error messages
 * @param {number} line line number, for error messages
 * @returns {string[]} local binding names
 */
export function parseSpecifiers(raw, file, line) {
  const names = [];
  const named = raw.match(/\{([\s\S]*?)\}/);
  if (named) {
    for (const piece of named[1].split(',')) {
      const s = piece.trim();
      if (!s) continue;
      const m = s.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (!m) fail(`${file}:${line} 无法解析具名导入片段: ${JSON.stringify(s)}`);
      names.push(m[2] || m[1]);
    }
  }
  if (/^\s*[\w$]/.test(raw)) fail(`${file}:${line} 禁止默认导入: ${JSON.stringify(raw.trim())}`);
  if (/\*\s*as\s+/.test(raw)) fail(`${file}:${line} 禁止命名空间导入（* as X）；请改用具名导入`);
  return names;
}

/**
 * Top-level binding names introduced by a declaration statement.
 *
 * `statement` is the whole statement WITHOUT its trailing `export ` keyword, e.g.
 * `const A = 1;`, `function f() {}`, or `const { a, b } = x;`. The name must come from
 * the statement itself — an earlier version derived it from a regex match that only
 * covered `export const `, so every module exported nothing and the extension silently
 * did nothing.
 *
 * @param {string} statement declaration text including the keyword
 * @param {string} kind one of const|let|var|function|class
 * @returns {string[]} declared names (several for a destructuring pattern)
 */
export function namesOfDeclaration(statement, kind) {
  const text = statement
    .replace(/^(?:async\s+)?(?:function|class|const|let|var)\s*\*?\s*/, '')
    .trim();

  if (kind === 'function' || kind === 'class') {
    const m = text.match(/^([\w$]+)/);
    return m ? [m[1]] : [];
  }

  // Take text up to the top-level `=`; the initializer may contain braces/parens.
  let depth = 0;
  let end = text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === '=' && depth === 0) {
      end = i;
      break;
    }
  }
  const head = text.slice(0, end).replace(/;$/, '').trim();

  if (head.startsWith('{') || head.startsWith('[')) {
    const names = [];
    for (const piece of head.replace(/[[\]{}]/g, ' ').split(',')) {
      const name = piece.split(':').pop().trim().replace(/^\.\.\./, '').split('=')[0].trim();
      if (/^[\w$]+$/.test(name)) names.push(name);
    }
    return names;
  }

  const names = [];
  for (const piece of head.split(',')) {
    const name = piece.split('=')[0].trim();
    if (/^[\w$]+$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * Mark every index that lies inside a comment or a string/template literal.
 *
 * Text-based checks over source code need this: `import(` appears in the doc comments
 * that *describe* the ban, and a `;` inside a template literal must not be mistaken for
 * the end of a statement.
 *
 * @param {string} code source text
 * @returns {Uint8Array} 1 where the character is inside a comment or literal
 */
export function maskedRegions(code) {
  const mask = new Uint8Array(code.length);
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      const end = nl === -1 ? code.length : nl;
      mask.fill(1, i, end);
      i = end;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      const end = close === -1 ? code.length : close + 2;
      mask.fill(1, i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') j += 2;
        else if (code[j] === quote) {
          j += 1;
          break;
        } else j += 1;
      }
      mask.fill(1, i, Math.min(j, code.length));
      i = j;
      continue;
    }
    i += 1;
  }
  return mask;
}

/**
 * Find the first occurrence of a pattern that is real code, not a comment or literal.
 * @param {string} code source text
 * @param {RegExp} pattern global regular expression
 * @returns {number} index of the match, or -1
 */
export function findCodePattern(code, pattern) {
  const mask = maskedRegions(code);
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match;
  while ((match = re.exec(code)) !== null) {
    if (mask[match.index] === 0) return match.index;
    // Zero-length matches would spin forever.
    if (match[0] === '') re.lastIndex += 1;
  }
  return -1;
}

/**
 * Slice a whole declaration statement starting at a keyword offset.
 *
 * Stops at the first top-level `;` or at the brace that closes a `function`/`class`
 * body, scanning inside strings, template literals and comments so a `;` inside a
 * string cannot truncate the statement.
 *
 * @param {string} code transformed module source
 * @param {number} start offset of the `const`/`let`/`var`/`function`/`class` keyword
 * @returns {string} the statement text, best effort
 */
export function declarationStatementAt(code, start) {
  const mask = maskedRegions(code);
  let i = start;
  let depth = 0;
  while (i < code.length) {
    if (mask[i] === 1) {
      i += 1;
      continue;
    }
    const ch = code[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth <= 0) return code.slice(start, i + 1);
    } else if (ch === ';' && depth === 0) {
      return code.slice(start, i + 1);
    }
    i += 1;
  }
  return code.slice(start);
}

/** Resolve a relative specifier to a repo-relative `.js` path, or mark it external. */export function resolveSpecifier(root, fromFile, spec) {
  if (!spec.startsWith('.')) return { external: true };
  const base = path.resolve(path.dirname(path.join(root, fromFile)), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    return { file: path.relative(root, candidate).split(path.sep).join('/') };
  }
  fail(`无法解析导入 ${JSON.stringify(spec)}（来自 ${fromFile}）`);
}

/**
 * Strip a module's import/export syntax and report what it declares and consumes.
 *
 * @param {string} file repo-relative module path
 * @param {string} source module source
 * @param {string} root repo root, for specifier resolution
 * @returns {{code: string, imports: {file: string, names: string[], line: number}[],
 *   externalImports: {spec: string, line: number}[],
 *   declared: Map<string, string>, imported: Set<string>,
 *   bindings: {file: string, names: string[]}[]}}
 *   `declared` maps local name → exported name; `bindings` groups imports by module.
 */
export function transformModule(file, source, root) {
  let code = source;
  const imports = [];
  const externalImports = [];
  /** local name → exported name */
  const declared = new Map();
  const imported = new Set();
  const bindings = [];

  const record = (rawSpecifiers, spec, offset) => {
    const line = lineOf(source, offset);
    const resolved = resolveSpecifier(root, file, spec);
    if (resolved.external) {
      externalImports.push({ spec, line });
      return;
    }
    const names = parseSpecifiers(rawSpecifiers, file, line);
    for (const name of names) imported.add(name);
    imports.push({ file: resolved.file, names, line });
    if (names.length) bindings.push({ file: resolved.file, names });
  };

  // 1. Side-effect-only imports: `import './x.js';`
  code = code.replace(/^[ \t]*import[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm, (match, spec, offset) => {
    record('', spec, offset);
    return blank(match);
  });

  // 2. Named imports, possibly spanning lines: `import {\n a,\n b as c\n} from './x.js';`
  code = code.replace(
    /^[ \t]*import[ \t]+([\s\S]*?)[ \t]*from[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm,
    (match, rawSpecifiers, spec, offset) => {
      record(rawSpecifiers, spec, offset);
      return blank(match);
    },
  );

  // 3. Dynamic import cannot be fenced; refuse it rather than emit a broken bundle.
  //    Must ignore the phrase "dynamic import()" inside comments and strings, which is
  //    how it is usually *documented* — a false positive blocks the build for no reason.
  const dynamicImport = findCodePattern(code, /\bimport\s*\(/);
  if (dynamicImport !== -1) {
    fail(`${file}:${lineOf(code, dynamicImport)} 禁止动态 import()；内容脚本不支持运行时模块加载`);
  }

  // 4. Re-exports hide the names this analysis needs; refuse them loudly.
  const reexport = /^[ \t]*export[ \t]+(?:\*|\{[\s\S]*?\})[ \t]*from[ \t]*['"]([^'"]+)['"]/gm.exec(code);
  if (reexport) {
    fail(
      `${file}:${lineOf(source, reexport.index)} 禁止 re-export（export ... from '${reexport[1]}'）；` +
        `请先 import 再 export`,
    );
  }

  // 5. `export default` has no meaning under fencing.
  const defaultMatch = /^[ \t]*export[ \t]+default[ \t]+/m.exec(code);
  if (defaultMatch) {
    fail(`${file}:${lineOf(code, defaultMatch.index)} 禁止 export default；请使用具名导出（见 CONTRACTS.md §0）`);
  }

  // 6. `export const|let|var|function|class|async function` → drop `export ` and
  //    record the declared names. A replace callback only sees the matched text (here
  //    just the keyword), so the name is read from the statement at the match offset.
  code = code.replace(
    /^([ \t]*)export[ \t]+((?:async[ \t]+)?(?:const|let|var|function|class))([ \t*]+)/gm,
    (match, indent, kind, gap, offset) => {
      const statement = declarationStatementAt(code, offset + indent.length + 'export '.length);
      const bare = kind.replace(/^async[ \t]+/, '');
      for (const name of namesOfDeclaration(statement, bare)) declared.set(name, name);
      return `${indent}${kind}${gap}`;
    },
  );

  // 7. `export { a, b as c };` → register the local binding under its public name.
  code = code.replace(/^[ \t]*export[ \t]*\{([\s\S]*?)\}[ \t]*;?[ \t]*$/gm, (match, raw) => {
    for (const piece of raw.split(',')) {
      const s = piece.trim();
      if (!s) continue;
      const m = s.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (!m) fail(`${file}:1 无法解析导出片段: ${JSON.stringify(s)}`);
      declared.set(m[1], m[2] || m[1]);
    }
    return blank(match);
  });

  // 8. Any remaining `export` is an unsupported form — say so instead of guessing.
  const leftover = /^[ \t]*export\b.*$/m.exec(code);
  if (leftover) {
    fail(`${file}:${lineOf(code, leftover.index)} 不支持的 export 形式: ${leftover[0].trim()}`);
  }

  return { code, imports, externalImports, declared, imported, bindings };
}

/* --------------------------------------------------------------------- graph */

/**
 * Depth-first topological sort: every module lands after its dependencies.
 *
 * @param {string} root repo root
 * @param {string[]} entries entry module paths
 * @returns {{order: string[], transform: (file: string) => any, external: Map<string, Set<string>>}}
 */
export function buildGraph(root, entries) {
  const cache = new Map();
  const state = new Map();
  const order = [];
  const external = new Map();

  const transform = (file) => {
    if (cache.has(file)) return cache.get(file);
    const source = readFileSync(path.join(root, file), 'utf8');
    const result = transformModule(file, source, root);
    cache.set(file, result);
    return result;
  };

  const visit = (file) => {
    const seen = state.get(file);
    if (seen === 'done') return;
    if (seen === 'visiting') fail(`检测到循环依赖: ${file}`);
    state.set(file, 'visiting');
    const mod = transform(file);
    for (const imp of mod.imports) visit(imp.file);
    for (const ext of mod.externalImports) {
      if (!external.has(ext.spec)) external.set(ext.spec, new Set());
      external.get(ext.spec).add(file);
    }
    state.set(file, 'done');
    order.push(file);
  };

  for (const entry of entries) visit(entry);
  return { order, transform, external };
}

/* ---------------------------------------------------------------------- emit */

/**
 * Rewrite one module into a fenced unit. The module body is NOT rewritten.
 *
 * @param {string} file module path
 * @param {string} code transformed source
 * @param {{file: string, names: string[]}[]} bindings resolved imports
 * @param {Map<string, string>} declared local name → exported name
 * @returns {string} fenced source
 */
export function fenceModule(file, code, bindings, declared) {
  const out = [`/* ===== ${file} ===== */`, `__ezr_define(${JSON.stringify(file)}, function () {`];

  for (const group of bindings) {
    out.push(`  const { ${group.names.join(', ')} } = __ezr_exports[${JSON.stringify(group.file)}];`);
  }

  out.push(code.replace(/\s+$/, ''));
  out.push('');

  const pairs = [...declared.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([local, exported]) => (local === exported ? local : `${JSON.stringify(exported)}: ${local}`));

  out.push(`  return { ${pairs.join(', ')} };`);
  out.push('});');
  out.push('');
  return out.join('\n');
}

/**
 * Produce the content-script bundle.
 *
 * @param {{order: string[], transform: (file: string) => any}} graph
 * @param {string} entry entry module path, asserted to be present
 * @returns {{bundled: string, modules: string[]}}
 */
export function emitBundle(graph, entry) {
  const { order, transform } = graph;
  const parts = [
    '/* EZ-Reader content bundle — generated by tools/build.js. Do not edit by hand. */',
    `/* ${order.length} modules, each fenced in its own scope and registered by path. */`,
    '(function () {',
    "  'use strict';",
    '  var __ezr_exports = Object.create(null);',
    '  var __ezr_defined = Object.create(null);',
    '',
    '  /** Define a fenced module. The graph is topologically ordered, so every',
    '   *  dependency is already defined when a dependent module runs. */',
    '  function __ezr_define(id, factory) {',
    '    if (__ezr_defined[id]) return;',
    '    __ezr_defined[id] = true;',
    '    __ezr_exports[id] = factory();',
    '  }',
    '',
  ];

  for (const file of order) {
    const mod = transform(file);
    parts.push(fenceModule(file, mod.code, mod.bindings, mod.declared));
  }

  // Fail loudly rather than shipping a bundle that parses but does nothing.
  parts.push(`  if (!__ezr_defined[${JSON.stringify(entry)}]) {`);
  parts.push(`    throw new Error("EZ-Reader build: ${entry} was not bundled");`);
  parts.push('  }');
  parts.push('})();');
  parts.push('');

  return { bundled: parts.join('\n'), modules: [...order] };
}

/** Stable, identifier-safe id for a module path: `src/core/render.js` → `core$render`. */
export const moduleIdOf = (file) => file.replace(/^src\//, '').replace(/\.js$/, '').split('/').join('$');
