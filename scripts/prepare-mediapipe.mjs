// Copies MediaPipe's WebAssembly runtime into public/mediapipe/ so Vite serves
// and bundles it locally (no CDN). The segmentation model lives in
// public/models/ and is committed. Only the SIMD build is copied: every
// supported Chromium/Electron version has WebAssembly SIMD.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'mediapipe');
// The package's exports map hides package.json, so locate it from the main entry.
const pkgDir = path.dirname(require.resolve('@mediapipe/tasks-vision'));

fs.mkdirSync(outDir, { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  fs.copyFileSync(path.join(pkgDir, 'wasm', f), path.join(outDir, f));
}
const model = path.join(root, 'public', 'models', 'selfie_segmenter_landscape.tflite');
if (!fs.existsSync(model)) {
  console.error('[prepare-mediapipe] Missing public/models/selfie_segmenter_landscape.tflite');
  process.exit(1);
}
console.log('[prepare-mediapipe] MediaPipe runtime copied to public/mediapipe');
