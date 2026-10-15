// Copies the FFmpeg and FFprobe binaries for the build target into
// resources/ffmpeg/, which Forge ships as an extra resource. Only the
// target platform's binaries are copied so packages stay small.
//
// ffmpeg-static downloads a binary for the host at install time. To build
// for another platform/arch, reinstall ffmpeg-static with
// npm_config_platform / npm_config_arch set, and set BLOOM_TARGET_PLATFORM /
// BLOOM_TARGET_ARCH when running this script.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.env.BLOOM_TARGET_PLATFORM || process.platform;
const arch = process.env.BLOOM_TARGET_ARCH || process.arch;
const exe = platform === 'win32' ? '.exe' : '';
const outDir = path.join(root, 'resources', 'ffmpeg');

function resolveFfmpeg() {
  try {
    const p = require('ffmpeg-static');
    return typeof p === 'string' ? p : null;
  } catch {
    return null;
  }
}

function resolveFfprobe() {
  try {
    const pkgDir = path.dirname(require.resolve('ffprobe-static/package.json'));
    return path.join(pkgDir, 'bin', platform, arch, `ffprobe${exe}`);
  } catch {
    return null;
  }
}

function copy(src, name) {
  if (!src || !fs.existsSync(src)) {
    console.warn(`[prepare-ffmpeg] ${name} binary not found for ${platform}-${arch} (looked at ${src}).`);
    return false;
  }
  const dest = path.join(outDir, `${name}${exe}`);
  fs.copyFileSync(src, dest);
  if (platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log(`[prepare-ffmpeg] ${name}: ${src} -> ${path.relative(root, dest)}`);
  return true;
}

fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) {
  if (/^ff(mpeg|probe)(\.exe)?$/.test(f)) fs.rmSync(path.join(outDir, f));
}
const ok = copy(resolveFfmpeg(), 'ffmpeg') & copy(resolveFfprobe(), 'ffprobe');
fs.writeFileSync(path.join(outDir, 'target.json'), JSON.stringify({ platform, arch }, null, 2));
if (!ok && process.env.npm_lifecycle_event !== 'postinstall') process.exit(1);
