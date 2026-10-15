import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DiskFullError, TrackWriter } from '../../electron/recording/track-writer';
import { readManifest, writeManifest } from '../../electron/recording/manifest';
import { createCapturePlatform, isWaylandSession } from '../../electron/capture/platform';
import { tmpDir } from '../helpers/media';

describe('track writer', () => {
  it('appends chunks progressively and in order', async () => {
    const file = path.join(tmpDir(), 'sub', 'screen.webm');
    const w = new TrackWriter(file, 0, async () => 10 ** 12);
    await w.open();
    await Promise.all([w.append(new Uint8Array([1, 2])), w.append(new Uint8Array([3])), w.append(new Uint8Array(0))]);
    // Data is on disk before close.
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3]);
    await w.append(new Uint8Array([4]));
    await w.close();
    await w.close(); // idempotent
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3, 4]);
    expect(w.bytesWritten).toBe(4);
  });

  it('resumes byte count when reopening an existing file', async () => {
    const file = path.join(tmpDir(), 'a.webm');
    fs.writeFileSync(file, Buffer.alloc(7));
    const w = new TrackWriter(file, 0, async () => null);
    await w.open();
    expect(w.bytesWritten).toBe(7);
    await w.close();
  });

  it('stops with DiskFullError when free space runs low, and keeps failing', async () => {
    const file = path.join(tmpDir(), 'b.webm');
    const free = vi.fn(async () => 100);
    const w = new TrackWriter(file, 1000, free);
    await w.open();
    await expect(w.append(new Uint8Array([1]))).rejects.toBeInstanceOf(DiskFullError);
    await expect(w.append(new Uint8Array([2]))).rejects.toBeInstanceOf(DiskFullError);
    await w.close();
    expect(fs.readFileSync(file).length).toBe(0);
  });

  it('rejects writes before open', async () => {
    const w = new TrackWriter(path.join(tmpDir(), 'c.webm'));
    await expect(w.append(new Uint8Array([1]))).rejects.toThrow(/not open/);
  });
});

describe('recovery manifest', () => {
  const manifest = {
    version: 1 as const,
    sessionId: '3f1c4d4e-8a52-4c1e-9a0b-2b7f5d7e9c11',
    status: 'recording',
    mode: 'screen' as const,
    startedAt: 1,
    endedAt: null,
    pauses: [],
    options: { mode: 'screen' },
    tracks: [{ kind: 'screen' as const, file: 'screen.webm', mimeType: 'video/webm', offsetMs: 0 }],
  };

  it('writes atomically and reads back', () => {
    const dir = tmpDir();
    writeManifest(dir, manifest);
    expect(readManifest(dir)).toEqual(manifest);
    expect(fs.existsSync(path.join(dir, 'manifest.json.tmp'))).toBe(false);
  });

  it('rejects corrupt manifests and path traversal in track files', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{oops');
    expect(readManifest(dir)).toBeNull();
    writeManifest(dir, { ...manifest, tracks: [{ ...manifest.tracks[0]!, file: '../../evil.webm' }] });
    expect(readManifest(dir)).toBeNull();
    expect(readManifest(path.join(dir, 'missing'))).toBeNull();
  });
});

describe('capture platform layer', () => {
  const electron = {
    getMediaAccessStatus: vi.fn(() => 'denied'),
    askForMediaAccess: vi.fn(async () => true),
    openExternal: vi.fn(async () => {}),
  };

  it('Windows supports loopback system audio and links to privacy settings', async () => {
    const p = createCapturePlatform('win32', 'x64', {}, electron);
    expect(p.capabilities().systemAudio).toBe(true);
    expect(p.loopbackAudio()).toBe('loopback');
    expect(p.permissionStatus('camera')).toBe('denied');
    expect(p.permissionStatus('screen')).toBe('granted');
    await p.openPermissionSettings('microphone');
    expect(electron.openExternal).toHaveBeenCalledWith('ms-settings:privacy-microphone');
  });

  it('macOS requests camera access and reports the screen-recording requirement', async () => {
    const p = createCapturePlatform('darwin', 'arm64', {}, electron);
    expect(p.capabilities().systemAudio).toBe(false);
    expect(p.capabilities().screenPermissionNote).toMatch(/Screen/);
    expect(p.loopbackAudio()).toBeNull();
    await p.requestPermission('camera');
    expect(electron.askForMediaAccess).toHaveBeenCalledWith('camera');
    await p.openPermissionSettings('screen');
    expect(electron.openExternal).toHaveBeenLastCalledWith(expect.stringContaining('Privacy_ScreenCapture'));
  });

  it('Linux detects Wayland and uses the system picker', () => {
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' })).toBe(true);
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'x11' })).toBe(false);
    const wl = createCapturePlatform('linux', 'x64', { WAYLAND_DISPLAY: 'wayland-0' }, electron);
    expect(wl.capabilities()).toMatchObject({ usesSystemPicker: true, isWayland: true, systemAudio: false });
    const x11 = createCapturePlatform('linux', 'x64', {}, electron);
    expect(x11.capabilities().usesSystemPicker).toBe(false);
    expect(x11.permissionStatus('camera')).toBe('granted');
  });
});
