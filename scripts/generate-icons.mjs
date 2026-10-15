// Renders the app icon (brand #263D42 gradient rounded square with a record ring) with
// the bundled FFmpeg and writes icon.png, icon.ico and icon.icns into
// resources/icons. Run once; the outputs are committed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = path.join(root, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const out = path.join(root, 'resources', 'icons');
fs.mkdirSync(out, { recursive: true });

function render(size, file) {
  const S = size;
  const R = S * 0.25; // corner radius
  // Signed distance to the rounded square; inside when <= 0.
  const rr = `(hypot(max(abs(X-${S / 2})-${S / 2 - R},0),max(abs(Y-${S / 2})-${S / 2 - R},0))-${R})`;
  const d = `hypot(X-${S / 2},Y-${S / 2})`;
  const ring = `between(${d},${S * 0.22},${S * 0.28})`;
  const dot = `lte(${d},${S * 0.125})`;
  const white = `max(${ring}*0.9,${dot})`;
  const t = `((X+Y)/${2 * S})`;
  const mix = (a, b) => `(${a}+(${b}-${a})*${t})*(1-${white})+255*${white}`;
  const alpha = `255*clip(0.5-${rr},0,1)`;
  execFileSync(ffmpeg, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${S}x${S},format=rgba`,
    '-vf', `geq=r='${mix(91, 38)}':g='${mix(140, 61)}':b='${mix(150, 66)}':a='${alpha}'`,
    '-frames:v', '1', file,
  ]);
}

const sizes = [1024, 512, 256];
const pngs = {};
for (const s of sizes) {
  const f = path.join(out, `icon-${s}.png`);
  render(s, f);
  pngs[s] = fs.readFileSync(f);
}
fs.copyFileSync(path.join(out, 'icon-512.png'), path.join(out, 'icon.png'));
execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', path.join(out, 'icon-256.png'), path.join(out, 'icon.ico')]);

// ICNS: header + PNG-encoded entries (ic08=256, ic09=512, ic10=1024).
const entries = [
  ['ic08', pngs[256]],
  ['ic09', pngs[512]],
  ['ic10', pngs[1024]],
].map(([type, data]) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(entries);
const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(path.join(out, 'icon.icns'), Buffer.concat([header, body]));
for (const s of sizes) fs.rmSync(path.join(out, `icon-${s}.png`));
console.log('Icons written to', path.relative(root, out));
