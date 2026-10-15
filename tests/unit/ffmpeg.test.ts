import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyFfmpegFailure, MediaError } from '../../electron/media/errors';
import { parseProgressLine, progressReporter } from '../../electron/media/progress';
import { parseProbeJson } from '../../electron/media/probe';
import { runProcess } from '../../electron/media/process-runner';
import { circleMaskPgm } from '../../electron/media/mask';
import { bins, hasFfmpeg, tmpDir } from '../helpers/media';

describe('FFmpeg error handling', () => {
  it('classifies common failures into meaningful messages', () => {
    expect(classifyFfmpegFailure('foo\n/out.mp4: No space left on device\nConversion failed!', 1).code).toBe('DISK_FULL');
    expect(classifyFfmpegFailure('in.webm: Invalid data found when processing input', 1).message).toMatch(/damaged or incomplete/);
    expect(classifyFfmpegFailure('Stream specifier :a matches no streams', 1).message).toMatch(/missing/);
    expect(classifyFfmpegFailure('x.mp4: Permission denied', 1).code).toBe('IO');
    const generic = classifyFfmpegFailure('something odd happened\nConversion failed!', 3);
    expect(generic.message).toBe('Media processing failed: something odd happened');
    expect(generic.details.exitCode).toBe(3);
    expect(classifyFfmpegFailure('', null).message).toMatch(/exit code unknown/);
  });

  it('parses -progress output', () => {
    expect(parseProgressLine('out_time_us=1500000')).toBe(1500);
    expect(parseProgressLine('out_time_ms=2500000')).toBe(2500);
    expect(parseProgressLine('out_time=00:01:02.500000')).toBe(62_500);
    expect(parseProgressLine('progress=end')).toBe('end');
    expect(parseProgressLine('out_time_us=N/A')).toBeNull();
    expect(parseProgressLine('frame=12')).toBeNull();
    expect(parseProgressLine('garbage')).toBeNull();
    const seen: Array<number | null> = [];
    const report = progressReporter(10_000, (f) => seen.push(f));
    report('out_time_us=5000000');
    report('out_time_us=5001000'); // below reporting granularity
    report('out_time_us=99000000'); // clamps below 1 until 'end'
    report('progress=end');
    expect(seen).toEqual([0.5, 0.999, 1]);
    const unknown: Array<number | null> = [];
    progressReporter(null, (f) => unknown.push(f))('out_time_us=1000');
    expect(unknown).toEqual([null]);
  });

  it('parses ffprobe JSON defensively', () => {
    const p = parseProbeJson(
      JSON.stringify({
        format: { format_name: 'mov,mp4', duration: '12.345', size: '1000' },
        streams: [
          { codec_type: 'video', codec_name: 'mjpeg', width: 10, height: 10, disposition: { attached_pic: 1 } },
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
        ],
      }),
    );
    expect(p).toEqual({
      formatName: 'mov,mp4',
      durationMs: 12_345,
      sizeBytes: 1000,
      video: { codec: 'h264', width: 1920, height: 1080, fps: 29.97 },
      audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
    });
    // Malicious/odd metadata does not crash.
    const odd = parseProbeJson(JSON.stringify({ format: { duration: 'N/A' }, streams: [{ codec_type: 'video', width: -1 }, null, 5] }));
    expect(odd).toMatchObject({ durationMs: null, video: null, audio: null });
    expect(() => parseProbeJson('not json')).toThrow(MediaError);
  });

  it('builds an anti-aliased circular mask', () => {
    const pgm = circleMaskPgm(10);
    const header = 'P5\n10 10\n255\n';
    expect(pgm.subarray(0, header.length).toString('ascii')).toBe(header);
    const px = (x: number, y: number) => pgm[header.length + y * 10 + x]!;
    expect(px(0, 0)).toBe(0);
    expect(px(5, 5)).toBe(255);
    expect(() => circleMaskPgm(1)).toThrow();
  });
});

const describeMedia = hasFfmpeg ? describe : describe.skip;

describeMedia('process runner (real FFmpeg)', () => {
  it('rejects relative binary paths (no PATH lookup)', async () => {
    await expect(runProcess('ffmpeg', ['-version'])).rejects.toThrow(/absolute/);
  });

  it('surfaces FFmpeg failures as MediaError', async () => {
    const missing = path.join(tmpDir(), 'does-not-exist.webm');
    await expect(runProcess(bins.ffmpeg, ['-v', 'error', '-i', missing, '-f', 'null', '-'])).rejects.toMatchObject({
      name: 'MediaError',
      code: 'NOT_FOUND',
    });
  });

  it('treats arguments literally — no shell interpretation', async () => {
    const dir = tmpDir();
    const evil = path.join(dir, 'x; echo pwned & calc.mp4');
    await expect(runProcess(bins.ffmpeg, ['-v', 'error', '-i', evil, '-f', 'null', '-'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cancels a running FFmpeg process', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = runProcess(
      bins.ffmpeg,
      ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=600', '-c:v', 'libx264', '-preset', 'veryslow', '-f', 'null', '-'],
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 300);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('rejects immediately if already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(runProcess(bins.ffmpeg, ['-version'], { signal: c.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
