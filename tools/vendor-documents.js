/** Download pinned browser libraries without running package install scripts. */
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = [
  ['pdfjs-dist', '6.3.289', 'sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw=='],
];
for (const [name, version, integrity] of packages) {
  const url = 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz';
  const work = path.join(root, 'test-artifacts', 'vendor-packages', name + '-' + version);
  const archive = path.join(work, 'package.tgz');
  await mkdir(work, { recursive: true });
  let bytes;
  try { bytes = await readFile(archive); } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Download failed: ' + name + ' HTTP ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== integrity) throw new Error('Integrity mismatch: ' + name);
  await writeFile(archive, bytes);
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  if (names.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..'))) throw new Error('Unsafe package path');
  execFileSync('tar', ['-xzf', archive, '-C', work]);
  const from = path.join(work, 'package');
  const to = path.join(root, 'src', 'vendor', name === 'pdfjs-dist' ? 'pdfjs' : name);
  await mkdir(to, { recursive: true });
  for (const file of ['pdf.mjs','pdf.worker.mjs']) await cp(path.join(from,'legacy','build',file),path.join(to,file));
  for (const file of ['pdf_viewer.mjs','pdf_viewer.css']) await cp(path.join(from,'legacy','web',file),path.join(to,file));
  for (const dir of ['cmaps','standard_fonts','wasm']) await cp(path.join(from,dir),path.join(to,dir),{recursive:true});
  await cp(path.join(from,'legacy','web','images'),path.join(to,'images'),{recursive:true});
  await cp(path.join(from,'LICENSE'),path.join(to,'LICENSE'));
  await writeFile(path.join(to, 'package-info.json'), JSON.stringify({ name, version, url, integrity }, null, 2) + '\n');
  console.log(name + '@' + version + ' vendored with integrity verified');
}
