import type { QualityPreset } from '@shared/recording-types';
import { AAC_BITRATE, X264_CRF } from './compose';

export interface TrimArgsOptions {
  input: string;
  output: string;
  startMs: number;
  endMs: number;
  /** accurate re-encodes for exact frame boundaries; fast stream-copies (cuts snap to keyframes). */
  mode: 'accurate' | 'fast';
  quality: QualityPreset;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

export function buildTrimArgs(o: TrimArgsOptions): string[] {
  const durationMs = o.endMs - o.startMs;
  if (!(durationMs > 0)) throw new Error('Invalid trim range');
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  // Input seeking (-ss before -i) is fast, and frame-accurate when re-encoding.
  if (o.startMs > 0) args.push('-ss', sec(o.startMs));
  args.push('-i', o.input, '-t', sec(durationMs), '-map', '0:v:0', '-map', '0:a:0?');
  if (o.mode === 'fast') {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(X264_CRF[o.quality]),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', AAC_BITRATE[o.quality],
      '-ar', '48000',
    );
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', o.output);
  return args;
}

export function buildThumbnailArgs(input: string, output: string, atMs: number): string[] {
  return [
    '-hide_banner', '-nostdin', '-y', '-v', 'error',
    '-ss', sec(Math.max(0, atMs)),
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '4',
    '-update', '1',
    output,
  ];
}

/** A representative frame: 1s in, or 10% in for very short clips. */
export function thumbnailTimeMs(durationMs: number | null): number {
  if (!durationMs || durationMs <= 0) return 0;
  return Math.min(1000, Math.floor(durationMs * 0.1));
}
