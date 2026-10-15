import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRecordingTitle, partialPathFor, safeFileBaseName, uniqueFilePath } from '../../electron/storage/filenames';
import { ApprovedPaths, assertPathInside, isPathInside } from '../../electron/security/path-guard';
import { parseRange } from '../../electron/security/range';
import { resolveFfmpegBinaries } from '../../electron/media/binaries';

describe('safe filenames', () => {
  it('strips separators, reserved characters and control characters', () => {
    expect(safeFileBaseName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(safeFileBaseName('tab\there\u0000')).toBe('tabhere');
    expect(safeFileBaseName('../../etc/passwd')).toBe('-..-etc-passwd');
    expect(safeFileBaseName('../../etc/passwd')).not.toContain('/');
  });

  it('never returns hidden, empty or reserved names', () => {
    expect(safeFileBaseName('...hidden')).toBe('hidden');
    expect(safeFileBaseName('   ')).toBe('Recording');
    expect(safeFileBaseName('CON')).toBe('CON_');
    expect(safeFileBaseName('lpt1')).toBe('lpt1_');
    expect(safeFileBaseName('name. . ')).toBe('name');
  });

  it('limits length', () => {
    expect(safeFileBaseName('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });

  it('keeps unicode titles', () => {
    expect(safeFileBaseName('Démo – 日本語 🎥')).toBe('Démo – 日本語 🎥');
  });

  it('generates unique paths and partial siblings', () => {
    const existing = new Set([path.join('/out', 'Demo.mp4'), path.join('/out', 'Demo (2).mp4')]);
    expect(uniqueFilePath('/out', 'Demo', 'mp4', (p) => existing.has(p))).toBe(path.join('/out', 'Demo (3).mp4'));
    expect(uniqueFilePath('/out', 'New', '.mp4', () => false)).toBe(path.join('/out', 'New.mp4'));
    expect(partialPathFor(path.join('/out', 'Demo.mp4'))).toBe(path.join('/out', '.Demo.partial.mp4'));
  });

  it('formats default titles', () => {
    expect(defaultRecordingTitle(new Date(2026, 0, 2, 3, 4, 5))).toBe('Recording 2026-01-02 03.04.05');
  });
});

describe('path guard', () => {
  const root = path.resolve('/data/videos');
  it('detects containment', () => {
    expect(isPathInside(root, path.join(root, 'a.mp4'))).toBe(true);
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(root, '..', 'secret'))).toBe(false);
    expect(isPathInside(root, path.resolve('/data/videos-evil/a'))).toBe(false);
    expect(() => assertPathInside(root, path.join(root, '../../x'))).toThrow(/outside/);
  });

  it('tracks approved locations', () => {
    const a = new ApprovedPaths();
    a.approve(root);
    expect(a.isApproved(path.join(root, 'x', 'y.mp4'))).toBe(true);
    expect(() => a.assert(path.resolve('/etc/passwd'))).toThrow(/approved/);
    a.revoke(root);
    expect(a.isApproved(path.join(root, 'x'))).toBe(false);
  });
});

describe('media protocol range parsing', () => {
  it('parses byte ranges', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-1', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid');
  });
});

describe('ffmpeg binary resolution', () => {
  it('uses bundled resources and never the PATH', () => {
    const packaged = resolveFfmpegBinaries({ isPackaged: true, resourcesPath: '/app/res', appPath: '/x', platform: 'linux' });
    expect(packaged.ffmpeg).toBe(path.join('/app/res', 'ffmpeg', 'ffmpeg'));
    const win = resolveFfmpegBinaries({ isPackaged: false, resourcesPath: '', appPath: 'C:\\proj', platform: 'win32' });
    expect(win.ffprobe.endsWith(path.join('resources', 'ffmpeg', 'ffprobe.exe'))).toBe(true);
  });
});
