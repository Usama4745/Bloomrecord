import fs from 'node:fs';
import path from 'node:path';
import type { BackgroundImageData } from '@shared/recording-types';

export const MAX_BACKGROUND_BYTES = 25 * 1024 * 1024;
const FILE_RE = /^custom-\d+\.(png|jpg|webp)$/;

/** Identifies PNG / JPEG / WebP from the file signature (never trusts the extension). */
export function sniffImageType(head: Uint8Array): { ext: 'png' | 'jpg' | 'webp'; mimeType: BackgroundImageData['mimeType'] } | null {
  const b = (i: number) => head[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return { ext: 'png', mimeType: 'image/png' };
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { ext: 'jpg', mimeType: 'image/jpeg' };
  const ascii = (s: number, e: number) => String.fromCharCode(...head.subarray(s, e));
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', mimeType: 'image/webp' };
  return null;
}

/**
 * Copies a user-chosen image into <userData>/backgrounds as the single custom
 * background, replacing any previous one. Returns the stored file name.
 */
export async function importBackgroundImage(source: string, dir: string, now = Date.now()): Promise<string> {
  const stat = await fs.promises.stat(source);
  if (!stat.isFile()) throw new Error('Choose an image file.');
  if (stat.size > MAX_BACKGROUND_BYTES) throw new Error('The image is too large (maximum 25 MB).');
  const handle = await fs.promises.open(source, 'r');
  const head = new Uint8Array(16);
  try {
    await handle.read(head, 0, 16, 0);
  } finally {
    await handle.close();
  }
  const type = sniffImageType(head);
  if (!type) throw new Error('Unsupported image. Use a PNG, JPEG or WebP file.');

  await fs.promises.mkdir(dir, { recursive: true });
  const fileName = `custom-${now}.${type.ext}`;
  await fs.promises.copyFile(source, path.join(dir, fileName));
  for (const f of await fs.promises.readdir(dir)) {
    if (f !== fileName && FILE_RE.test(f)) await fs.promises.rm(path.join(dir, f), { force: true });
  }
  return fileName;
}

export async function readBackgroundImage(dir: string, fileName: string | null): Promise<BackgroundImageData | null> {
  if (!fileName || !FILE_RE.test(fileName)) return null;
  let data: Buffer;
  try {
    data = await fs.promises.readFile(path.join(dir, fileName));
  } catch {
    return null;
  }
  const type = sniffImageType(data.subarray(0, 16));
  return type ? { mimeType: type.mimeType, data: new Uint8Array(data) } : null;
}
