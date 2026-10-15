import fs from 'node:fs';
import path from 'node:path';

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_BASENAME = 80;

/**
 * Turns an arbitrary user-supplied title into a filename that is safe on
 * Windows, macOS and Linux. The result never contains path separators, so it
 * cannot escape the directory it is joined to.
 */
export function safeFileBaseName(title: string, fallback = 'Recording'): string {
  let name = title
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots would hide the file; trailing dots/spaces are stripped by Windows.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (name.length > MAX_BASENAME) name = name.slice(0, MAX_BASENAME).replace(/[.\s]+$/, '');
  if (!name || RESERVED_WINDOWS.test(name)) name = name ? `${name}_` : fallback;
  return name;
}

/** Default recording title, e.g. "Recording 2026-10-15 14.03.22". */
export function defaultRecordingTitle(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Recording ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
}

/** Returns dir/base.ext, or dir/base (2).ext etc. if it already exists. */
export function uniqueFilePath(dir: string, base: string, ext: string, exists: (p: string) => boolean = fs.existsSync): string {
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  let candidate = path.join(dir, `${base}${cleanExt}`);
  for (let i = 2; exists(candidate) || exists(partialPathFor(candidate)); i++) {
    if (i > 10_000) throw new Error('Could not find a free filename');
    candidate = path.join(dir, `${base} (${i})${cleanExt}`);
  }
  return candidate;
}

/** In-progress output is written next to the final file and renamed on success. */
export function partialPathFor(finalPath: string): string {
  const dir = path.dirname(finalPath);
  const ext = path.extname(finalPath);
  return path.join(dir, `.${path.basename(finalPath, ext)}.partial${ext}`);
}
