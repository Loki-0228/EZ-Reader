/**
 * Unit-test runner — zero dependencies.
 *
 * Why not plain `node --test test/`? That spawns one child process per test file with
 * piped stdio, which fails with `spawn EPERM` inside confined sandboxes (named pipes
 * are denied there). `run({ isolation: 'none' })` executes every test file in THIS
 * process, so no child is ever spawned, and the behaviour is identical in a normal
 * shell.
 *
 * Usage:  node tools/run-tests.js [nameFilter]
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');
const filter = process.argv[2] || '';

const all = (await readdir(TEST_DIR)).filter((n) => n.endsWith('.test.js')).sort();
const files = (filter ? all.filter((n) => n.includes(filter)) : all).map((n) => path.join(TEST_DIR, n));

if (!files.length) {
  console.error(`[test] test/ 下没有匹配 ${JSON.stringify(filter)} 的 *.test.js`);
  process.exitCode = 1;
} else {
  console.log(`[test] 运行 ${files.length} 个测试文件（in-process，无子进程）\n`);

  let pass = 0;
  let fail = 0;
  let skip = 0;
  const failures = [];

  const stream = run({
    files,
    concurrency: 1,
    isolation: 'none',
    timeout: 60000,
    // Keep the reporter output readable rather than a wall of TAP.
    reporter: 'spec',
  });

  for await (const event of stream) {
    const data = event.data || {};
    if (event.type === 'test:pass' && data.nesting === 0) pass += 1;
    else if (event.type === 'test:fail' && data.nesting === 0) {
      fail += 1;
      const message = data.details?.error?.message || data.details?.error || 'unknown failure';
      failures.push({ name: data.name, message: String(message) });
    } else if (event.type === 'test:skip' && data.nesting === 0) skip += 1;
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`测试文件 ${files.length} · 通过 ${pass} · 失败 ${fail}${skip ? ` · 跳过 ${skip}` : ''}`);
  if (fail) {
    console.log('\n失败明细:');
    for (const f of failures) {
      console.log(`  ✖ ${f.name}`);
      for (const line of f.message.split('\n').slice(0, 6)) console.log(`      ${line}`);
    }
    process.exitCode = 1;
  }
}
