// Copies the Windows installer produced by `electron-forge make` into
// installer/ (tracked in git) under a URL-friendly name, so the README can
// link to it. Older installers in that folder are removed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version, productName } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const arch = process.env.BLOOM_TARGET_ARCH || process.arch;
const src = path.join(root, 'out', 'make', 'squirrel.windows', arch, `${productName}-${version} Setup.exe`);
const outDir = path.join(root, 'installer');

if (!fs.existsSync(src)) {
  console.log(`[copy-installer] No Windows installer at ${path.relative(root, src)}; skipping.`);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) {
  if (/^BloomRecord-Setup-.*\.exe$/.test(f)) fs.rmSync(path.join(outDir, f));
}
const dest = path.join(outDir, `BloomRecord-Setup-${version}-${arch}.exe`);
fs.copyFileSync(src, dest);
console.log(`[copy-installer] ${path.relative(root, dest)} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(0)} MB)`);
