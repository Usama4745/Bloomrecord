import { describe, expect, it } from 'vitest';
import {
  exportRequestSchema,
  listRecordingsRequestSchema,
  recorderMimeSchema,
  renameRecordingRequestSchema,
  settingsPatchSchema,
  startRecordingRequestSchema,
  titleSchema,
  writeChunkRequestSchema,
  MAX_CHUNK_BYTES,
} from '@shared/validation';
import { decodeIpcError, encodeIpcError } from '@shared/ipc-contracts';

const uuid = '3f1c4d4e-8a52-4c1e-9a0b-2b7f5d7e9c11';

const baseStart = {
  mode: 'screen-camera' as const,
  sourceId: 'screen:0:0',
  sourceName: 'Entire screen',
  tracks: [
    { kind: 'screen' as const, mimeType: 'video/webm;codecs=vp9' },
    { kind: 'camera' as const, mimeType: 'video/webm;codecs=vp8' },
    { kind: 'mic' as const, mimeType: 'audio/webm;codecs=opus' },
  ],
  bubblePosition: 'bottom-left' as const,
  bubbleSize: 'medium' as const,
  quality: 'high' as const,
  frameRate: 30 as const,
  resolution: '1080p' as const,
};

describe('IPC input validation', () => {
  it('accepts a valid start request', () => {
    expect(startRecordingRequestSchema.safeParse(baseStart).success).toBe(true);
  });

  it('rejects unknown keys (strict schemas)', () => {
    expect(startRecordingRequestSchema.safeParse({ ...baseStart, evil: true }).success).toBe(false);
  });

  it('rejects duplicate tracks and mode/track mismatches', () => {
    const dup = { ...baseStart, tracks: [...baseStart.tracks, { kind: 'mic', mimeType: 'audio/webm' }] };
    expect(startRecordingRequestSchema.safeParse(dup).success).toBe(false);
    expect(startRecordingRequestSchema.safeParse({ ...baseStart, mode: 'screen' }).success).toBe(false);
    expect(
      startRecordingRequestSchema.safeParse({
        ...baseStart,
        mode: 'camera',
        sourceId: null,
        tracks: [{ kind: 'screen', mimeType: 'video/webm' }],
      }).success,
    ).toBe(false);
    expect(startRecordingRequestSchema.safeParse({ ...baseStart, sourceId: null }).success).toBe(false);
  });

  it('accepts camera-only without a source', () => {
    const r = startRecordingRequestSchema.safeParse({
      ...baseStart,
      mode: 'camera',
      sourceId: null,
      sourceName: null,
      tracks: [
        { kind: 'camera', mimeType: 'video/webm' },
        { kind: 'mic', mimeType: 'audio/webm' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unsupported MIME types and injection attempts', () => {
    expect(recorderMimeSchema.safeParse('video/webm;codecs=vp9,opus').success).toBe(true);
    expect(recorderMimeSchema.safeParse('video/mp4').success).toBe(true);
    expect(recorderMimeSchema.safeParse('text/html').success).toBe(false);
    expect(recorderMimeSchema.safeParse('video/webm;$(rm -rf)').success).toBe(false);
  });

  it('validates chunk payloads', () => {
    expect(writeChunkRequestSchema.safeParse({ sessionId: uuid, kind: 'screen', data: new Uint8Array(10) }).success).toBe(true);
    expect(writeChunkRequestSchema.safeParse({ sessionId: uuid, kind: 'screen', data: 'abc' }).success).toBe(false);
    expect(writeChunkRequestSchema.safeParse({ sessionId: 'not-a-uuid', kind: 'screen', data: new Uint8Array(1) }).success).toBe(false);
    expect(writeChunkRequestSchema.safeParse({ sessionId: uuid, kind: 'webcam', data: new Uint8Array(1) }).success).toBe(false);
    const big = { byteLength: MAX_CHUNK_BYTES + 1 } as Uint8Array;
    Object.setPrototypeOf(big, Uint8Array.prototype);
    expect(writeChunkRequestSchema.safeParse({ sessionId: uuid, kind: 'screen', data: big }).success).toBe(false);
  });

  it('validates titles', () => {
    expect(titleSchema.parse('  My demo  ')).toBe('My demo');
    expect(titleSchema.safeParse('').success).toBe(false);
    expect(titleSchema.safeParse('bad\u0000name').success).toBe(false);
    expect(titleSchema.safeParse('x'.repeat(201)).success).toBe(false);
    expect(renameRecordingRequestSchema.safeParse({ id: uuid, title: '../../etc/passwd' }).success).toBe(true); // stored as text only
  });

  it('does not allow the renderer to set the output folder', () => {
    expect(settingsPatchSchema.safeParse({ outputDir: 'C:\\Windows' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ frameRate: 60, theme: 'dark' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ frameRate: 59 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ countdownSeconds: 11 }).success).toBe(false);
  });

  it('validates export requests including replace confirmation', () => {
    const ok = { recordingId: uuid, startMs: 0, endMs: 1000, mode: 'accurate', quality: 'high', destination: 'library' };
    expect(exportRequestSchema.safeParse(ok).success).toBe(true);
    expect(exportRequestSchema.safeParse({ ...ok, endMs: 0 }).success).toBe(false);
    expect(exportRequestSchema.safeParse({ ...ok, startMs: -5 }).success).toBe(false);
    expect(exportRequestSchema.safeParse({ ...ok, destination: 'replace' }).success).toBe(false);
    expect(exportRequestSchema.safeParse({ ...ok, destination: 'replace', confirmReplace: true }).success).toBe(true);
    expect(exportRequestSchema.safeParse({ ...ok, outputPath: '/tmp/x.mp4' }).success).toBe(false);
  });

  it('bounds list requests', () => {
    expect(listRecordingsRequestSchema.safeParse({ search: 'a'.repeat(201) }).success).toBe(false);
    expect(listRecordingsRequestSchema.safeParse({ sort: 'random' }).success).toBe(false);
    expect(listRecordingsRequestSchema.safeParse({}).success).toBe(true);
  });

  it('round-trips error codes across the bridge', () => {
    const wire = `Error invoking remote method 'x': Error: ${encodeIpcError('DISK_FULL', 'Disk is full')}`;
    expect(decodeIpcError(new Error(wire))).toEqual({ code: 'DISK_FULL', message: 'Disk is full' });
    expect(decodeIpcError(new Error('plain'))).toEqual({ code: 'INTERNAL', message: 'plain' });
  });
});
