import { MediaError } from './errors';
import { runProcess } from './process-runner';
import { parseProgressLine } from './progress';

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  fps: number | null;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number | null;
  channels: number | null;
}

export interface MediaProbe {
  formatName: string;
  durationMs: number | null;
  sizeBytes: number | null;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseRate(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const [a, b] = v.split('/').map(Number);
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const r = a / b;
  return r > 0 && r <= 1000 ? Math.round(r * 1000) / 1000 : null;
}

/** Defensive parse of `ffprobe -print_format json` output. Unexpected shapes yield nulls, never throws on odd metadata. */
export function parseProbeJson(raw: string): MediaProbe {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new MediaError('MEDIA', 'Could not read media information (invalid ffprobe output).');
  }
  const obj = (data && typeof data === 'object' ? data : {}) as { format?: Record<string, unknown>; streams?: unknown[] };
  const format = obj.format ?? {};
  const streams = Array.isArray(obj.streams) ? (obj.streams as Array<Record<string, unknown>>) : [];

  const v = streams.find((s) => s && s.codec_type === 'video' && !(s.disposition as Record<string, number> | undefined)?.attached_pic);
  const a = streams.find((s) => s && s.codec_type === 'audio');

  const durationSec = num(format.duration) ?? num(v?.duration) ?? num(a?.duration);
  const width = num(v?.width);
  const height = num(v?.height);

  return {
    formatName: typeof format.format_name === 'string' ? format.format_name.slice(0, 100) : 'unknown',
    durationMs: durationSec !== null && durationSec > 0 ? Math.round(durationSec * 1000) : null,
    sizeBytes: num(format.size),
    video:
      v && width && height && width > 0 && height > 0
        ? {
            codec: String(v.codec_name ?? 'unknown').slice(0, 50),
            width,
            height,
            fps: parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate),
          }
        : null,
    audio: a
      ? {
          codec: String(a.codec_name ?? 'unknown').slice(0, 50),
          sampleRate: num(a.sample_rate),
          channels: num(a.channels),
        }
      : null,
  };
}

export async function probeMedia(ffprobe: string, file: string, signal?: AbortSignal): Promise<MediaProbe> {
  const { stdout } = await runProcess(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { signal, collectStdout: true, timeoutMs: 60_000 },
  );
  return parseProbeJson(stdout);
}

/**
 * Measures duration by remuxing to the null muxer. Needed for MediaRecorder
 * WebM files, which carry no duration in their header.
 */
export async function measureDurationMs(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number | null> {
  let last: number | null = null;
  await runProcess(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0', '-c', 'copy', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'],
    {
      signal,
      timeoutMs: 10 * 60_000,
      onStdoutLine: (line) => {
        const v = parseProgressLine(line);
        if (typeof v === 'number' && v > 0) last = v;
      },
    },
  );
  return last !== null ? Math.round(last) : null;
}
