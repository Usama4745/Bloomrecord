import { describe, expect, it } from 'vitest';
import { clampTrim, isFullRange, MIN_SEGMENT_MS, validateTrim } from '@shared/trim';
import { buildThumbnailArgs, buildTrimArgs, thumbnailTimeMs } from '../../electron/media/trim';

describe('trim boundary validation', () => {
  it('accepts valid ranges', () => {
    expect(validateTrim(0, 10_000, 10_000)).toEqual({ ok: true });
    expect(validateTrim(1000, 1500, 10_000)).toEqual({ ok: true });
    expect(validateTrim(0, 10_040, 10_000)).toEqual({ ok: true }); // container rounding slack
  });

  it('rejects invalid ranges', () => {
    expect(validateTrim(-1, 1000, 10_000).ok).toBe(false);
    expect(validateTrim(2000, 2000, 10_000).ok).toBe(false);
    expect(validateTrim(3000, 2000, 10_000).ok).toBe(false);
    expect(validateTrim(0, MIN_SEGMENT_MS - 1, 10_000).ok).toBe(false);
    expect(validateTrim(0, 11_000, 10_000).ok).toBe(false);
    expect(validateTrim(NaN, 1000, 10_000).ok).toBe(false);
    expect(validateTrim(0, 1000, 0).ok).toBe(false);
  });

  it('clamps handles inside the video and keeps a minimum gap', () => {
    expect(clampTrim(-500, 20_000, 10_000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(clampTrim(9900, 9950, 10_000)).toEqual({ startMs: 9500, endMs: 10_000 });
    expect(clampTrim(3000, 3100, 10_000)).toEqual({ startMs: 3000, endMs: 3500 });
    expect(isFullRange(0, 10_000, 10_000)).toBe(true);
    expect(isFullRange(100, 10_000, 10_000)).toBe(false);
  });

  it('builds accurate and fast trim arguments', () => {
    const accurate = buildTrimArgs({ input: '/in.mp4', output: '/out.mp4', startMs: 1500, endMs: 4000, mode: 'accurate', quality: 'high' });
    expect(accurate).toEqual(expect.arrayContaining(['-ss', '1.500', '-t', '2.500', '-c:v', 'libx264', '-c:a', 'aac']));
    expect(accurate.indexOf('-ss')).toBeLessThan(accurate.indexOf('-i'));
    expect(accurate.at(-1)).toBe('/out.mp4');
    const fast = buildTrimArgs({ input: '/in.mp4', output: '/out.mp4', startMs: 0, endMs: 4000, mode: 'fast', quality: 'high' });
    expect(fast).toEqual(expect.arrayContaining(['-c', 'copy']));
    expect(fast).not.toContain('-ss');
    expect(() => buildTrimArgs({ input: 'a', output: 'b', startMs: 5, endMs: 5, mode: 'fast', quality: 'low' })).toThrow();
  });

  it('picks a sensible thumbnail time', () => {
    expect(thumbnailTimeMs(null)).toBe(0);
    expect(thumbnailTimeMs(3000)).toBe(300);
    expect(thumbnailTimeMs(60_000)).toBe(1000);
    expect(buildThumbnailArgs('/a.mp4', '/t.jpg', 1000)).toEqual(expect.arrayContaining(['-frames:v', '1', '-ss', '1.000']));
  });
});
