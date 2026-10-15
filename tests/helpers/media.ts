import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFfmpegBinaries } from '../../electron/media/binaries';

export const bins = resolveFfmpegBinaries({
  isPackaged: false,
  resourcesPath: '',
  appPath: path.resolve(__dirname, '../..'),
  platform: process.platform,
});

export const hasFfmpeg = fs.existsSync(bins.ffmpeg) && fs.existsSync(bins.ffprobe);

export function tmpDir(prefix = 'bloom-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function ffmpeg(args: string[]): Buffer {
  return execFileSync(bins.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args], {
    maxBuffer: 512 * 1024 * 1024,
  });
}

/** WebM video like MediaRecorder produces (VP8), from a lavfi source graph. */
export function makeVideoWebm(file: string, lavfi: string): string {
  ffmpeg(['-f', 'lavfi', '-i', lavfi, '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-an', file]);
  return file;
}

/** WebM Opus audio like MediaRecorder produces. */
export function makeAudioWebm(file: string, lavfi: string): string {
  ffmpeg(['-f', 'lavfi', '-i', lavfi, '-c:a', 'libopus', '-b:a', '96k', '-vn', file]);
  return file;
}

/** Decodes one frame at `atSec` to RGB24. */
export function frameRgb(file: string, atSec: number, width: number, height: number): (x: number, y: number) => [number, number, number] {
  const buf = ffmpeg(['-ss', String(atSec), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  if (buf.length < width * height * 3) throw new Error(`Short frame: ${buf.length}`);
  return (x, y) => {
    const i = (y * width + x) * 3;
    return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
  };
}

/** Time (s) of the first video frame whose mean luma exceeds `threshold`. */
export function firstBrightFrameSec(file: string, fps: number, threshold = 128): number | null {
  const buf = ffmpeg(['-i', file, '-vf', `fps=${fps},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
  const idx = buf.findIndex((v) => v > threshold);
  return idx < 0 ? null : idx / fps;
}

/** Time (s) of the first audio sample whose amplitude exceeds `threshold` (0..1). */
export function firstLoudSampleSec(file: string, threshold = 0.2): number | null {
  const rate = 48000;
  const buf = ffmpeg(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']);
  const limit = threshold * 32767;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (Math.abs(buf.readInt16LE(i)) > limit) return i / 2 / rate;
  }
  return null;
}

/** Peak absolute sample (0..1) of the first audio stream. */
export function peakLevel(file: string): number {
  const buf = ffmpeg(['-i', file, '-map', '0:a:0', '-ac', '1', '-f', 's16le', 'pipe:1']);
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
  return peak / 32768;
}
