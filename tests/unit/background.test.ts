import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importBackgroundImage, MAX_BACKGROUND_BYTES, readBackgroundImage, sniffImageType } from '../../electron/library/background-images';
import { coverRect, processingSize, presetCss } from '@/services/background-presets';
import { settingsPatchSchema } from '@shared/validation';
import { tmpDir } from '../helpers/media';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');

describe('background image storage', () => {
  it('identifies images by signature, not extension', () => {
    expect(sniffImageType(PNG)?.mimeType).toBe('image/png');
    expect(sniffImageType(JPG)?.ext).toBe('jpg');
    expect(sniffImageType(WEBP)?.ext).toBe('webp');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns=...'))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it('imports one custom image, replacing the previous one', async () => {
    const src = tmpDir();
    const dir = path.join(tmpDir(), 'backgrounds');
    const a = path.join(src, 'photo.jpeg');
    fs.writeFileSync(a, JPG);
    const first = await importBackgroundImage(a, dir, 1);
    expect(first).toBe('custom-1.jpg');
    const b = path.join(src, 'misnamed.jpg'); // actually a PNG
    fs.writeFileSync(b, PNG);
    const second = await importBackgroundImage(b, dir, 2);
    expect(second).toBe('custom-2.png');
    expect(fs.readdirSync(dir)).toEqual(['custom-2.png']);
    expect((await readBackgroundImage(dir, second))?.mimeType).toBe('image/png');
  });

  it('rejects non-images, oversized files and unsafe names', async () => {
    const src = tmpDir();
    const dir = tmpDir();
    const txt = path.join(src, 'evil.png');
    fs.writeFileSync(txt, 'not an image');
    await expect(importBackgroundImage(txt, dir)).rejects.toThrow(/Unsupported image/);
    const big = path.join(src, 'big.png');
    fs.writeFileSync(big, PNG);
    fs.truncateSync(big, MAX_BACKGROUND_BYTES + 1);
    await expect(importBackgroundImage(big, dir)).rejects.toThrow(/too large/);
    await expect(importBackgroundImage(src, dir)).rejects.toThrow(/image file/);
    expect(await readBackgroundImage(dir, '../secret.png')).toBeNull();
    expect(await readBackgroundImage(dir, null)).toBeNull();
    expect(await readBackgroundImage(dir, 'custom-9.png')).toBeNull(); // missing
  });

  it('does not let the renderer set the custom image path', () => {
    expect(settingsPatchSchema.safeParse({ backgroundCustomImage: '../../x.png' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ backgroundEffect: 'blur', backgroundBlur: 'light' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ backgroundPreset: 'nope' }).success).toBe(false);
  });
});

describe('background layout helpers', () => {
  it('covers the frame without distortion', () => {
    expect(coverRect(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    const tall = coverRect(1000, 2000, 1280, 720);
    expect(tall.w).toBe(1280);
    expect(tall.h).toBe(2560);
    expect(tall.y).toBe(-920);
    expect(coverRect(0, 0, 10, 10)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it('caps processing resolution and keeps it even', () => {
    expect(processingSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(processingSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(processingSize(0, 0)).toEqual({ width: 1280, height: 720 });
    expect(processingSize(1001, 563)).toEqual({ width: 1002, height: 564 });
  });

  it('renders preset swatches as CSS gradients', () => {
    expect(presetCss('aurora')).toMatch(/^linear-gradient\(135deg, #2b1055/);
  });
});
