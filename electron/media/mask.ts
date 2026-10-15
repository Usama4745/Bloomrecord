import fs from 'node:fs';

/**
 * Builds an anti-aliased circular alpha mask as a binary PGM (P5) image:
 * white inside the circle, black outside, with a one-pixel soft edge.
 * FFmpeg reads it with `-loop 1 -i mask.pgm` and applies it via alphamerge.
 */
export function circleMaskPgm(size: number): Buffer {
  if (!Number.isInteger(size) || size < 2 || size > 8192) throw new Error('Invalid mask size');
  const header = Buffer.from(`P5\n${size} ${size}\n255\n`, 'ascii');
  const pixels = Buffer.alloc(size * size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const coverage = Math.min(1, Math.max(0, r - d + 0.5));
      pixels[y * size + x] = Math.round(coverage * 255);
    }
  }
  return Buffer.concat([header, pixels]);
}

export function writeCircleMask(file: string, size: number): void {
  fs.writeFileSync(file, circleMaskPgm(size));
}
