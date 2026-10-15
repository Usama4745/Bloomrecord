import type {
  BubblePosition,
  BubbleSize,
  FrameRate,
  QualityPreset,
  RecordingMode,
  ResolutionPreset,
  TrackKind,
} from '@shared/recording-types';
import { MediaError } from './errors';
import type { MediaProbe } from './probe';

export interface ComposeInput {
  kind: TrackKind;
  path: string;
  /** When this track's recorder started, relative to the session reference (ms). */
  offsetMs: number;
  probe: MediaProbe;
  /** Measured duration (WebM from MediaRecorder lacks one in its header). */
  durationMs: number | null;
}

export interface ComposeOptions {
  mode: RecordingMode;
  bubblePosition: BubblePosition;
  bubbleSize: BubbleSize;
  quality: QualityPreset;
  frameRate: FrameRate;
  resolution: ResolutionPreset;
  outputPath: string;
  /** Path to write/read the circular PGM mask for the given diameter. */
  maskPathFor: (diameter: number) => string;
}

export interface ComposePlan {
  args: string[];
  width: number;
  height: number;
  bubble: { diameter: number; x: number; y: number } | null;
  audioSources: TrackKind[];
  expectedDurationMs: number | null;
  /** Non-fatal issues (e.g. camera file unusable, so no bubble). */
  warnings: string[];
}

export const RESOLUTION_HEIGHT: Record<Exclude<ResolutionPreset, 'native'>, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
};

export const BUBBLE_FRACTION: Record<BubbleSize, number> = { small: 0.18, medium: 0.25, large: 0.33 };

export const X264_CRF: Record<QualityPreset, number> = { low: 28, medium: 23, high: 19 };
export const AAC_BITRATE: Record<QualityPreset, string> = { low: '96k', medium: '128k', high: '192k' };

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Fits the source inside the preset's bounding box (16:9 box of the preset height), never upscaling. */
export function outputSize(srcW: number, srcH: number, resolution: ResolutionPreset): { width: number; height: number } {
  if (resolution === 'native') return { width: even(srcW), height: even(srcH) };
  const maxH = RESOLUTION_HEIGHT[resolution];
  const maxW = Math.round((maxH * 16) / 9);
  const scale = Math.min(1, maxW / srcW, maxH / srcH);
  return { width: even(srcW * scale), height: even(srcH * scale) };
}

export function bubbleLayout(
  width: number,
  height: number,
  size: BubbleSize,
  position: BubblePosition,
): { diameter: number; x: number; y: number } {
  const short = Math.min(width, height);
  const diameter = even(Math.max(64, short * BUBBLE_FRACTION[size]));
  const margin = Math.round(short * 0.035);
  const x = position.endsWith('left') ? margin : width - diameter - margin;
  const y = position.startsWith('top') ? margin : height - diameter - margin;
  return { diameter, x: Math.max(0, x), y: Math.max(0, y) };
}

function usableVideo(i: ComposeInput | undefined): i is ComposeInput {
  return !!i && !!i.probe.video;
}
function usableAudio(i: ComposeInput | undefined): i is ComposeInput {
  return !!i && !!i.probe.audio;
}

/**
 * Builds the FFmpeg invocation that turns the separately recorded tracks into
 * one MP4: screen (or camera) as the base layer, the camera as a circular
 * bubble, and microphone + system audio mixed without clipping.
 *
 * All tracks are aligned to the base video using the recorder start offsets,
 * the base is converted to constant frame rate (screen capture is VFR), and
 * audio is resampled with async correction so pauses and dropouts stay in sync.
 */
export function planCompose(inputs: ComposeInput[], opts: ComposeOptions): ComposePlan {
  const warnings: string[] = [];
  const byKind = new Map(inputs.map((i) => [i.kind, i]));
  const screen = byKind.get('screen');
  const camera = byKind.get('camera');

  let base: ComposeInput;
  let overlayCam: ComposeInput | null = null;
  if (opts.mode === 'camera') {
    if (!usableVideo(camera)) throw new MediaError('MEDIA', 'The camera recording is missing or contains no video.');
    base = camera;
  } else {
    if (!usableVideo(screen)) throw new MediaError('MEDIA', 'The screen recording is missing or contains no video.');
    base = screen;
    if (opts.mode === 'screen-camera') {
      if (usableVideo(camera)) overlayCam = camera;
      else warnings.push('Camera track was empty or unreadable; exported without the webcam bubble.');
    }
  }

  const audioInputs: ComposeInput[] = [];
  for (const kind of ['mic', 'system'] as const) {
    const a = byKind.get(kind);
    if (!a) continue;
    if (usableAudio(a)) audioInputs.push(a);
    else warnings.push(`${kind === 'mic' ? 'Microphone' : 'System audio'} track was empty or unreadable and was skipped.`);
  }

  const { width, height } = outputSize(base.probe.video!.width, base.probe.video!.height, opts.resolution);
  const fps = opts.frameRate;

  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  const ordered: ComposeInput[] = [base, ...(overlayCam ? [overlayCam] : []), ...audioInputs];
  for (const input of ordered) {
    args.push('-fflags', '+genpts', '-i', input.path);
  }

  const filters: string[] = [];
  // Shift relative to the base video: positive = starts later than base, negative = started earlier.
  const delta = (i: ComposeInput) => i.offsetMs - base.offsetMs;

  // Base layer: CFR at target fps, letterboxed into the output size. scale+pad copes with
  // mid-stream resolution changes (e.g. a captured window being resized).
  filters.push(
    `[0:v]setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[base]`,
  );

  let videoOut = 'base';
  let bubble: ComposePlan['bubble'] = null;
  let inputIndex = 1;
  if (overlayCam) {
    bubble = bubbleLayout(width, height, opts.bubbleSize, opts.bubblePosition);
    const d = bubble.diameter;
    const camIdx = inputIndex++;
    const maskIdx = ordered.length; // mask input is appended after all media inputs
    const shift = delta(overlayCam);
    const align =
      shift >= 0 ? `setpts=PTS-STARTPTS+${sec(shift)}/TB` : `trim=start=${sec(-shift)},setpts=PTS-STARTPTS`;
    // Center-crop to a square (no distortion), scale to the bubble, then apply the circular alpha mask.
    filters.push(
      `[${camIdx}:v]${align},fps=${fps},crop='min(iw,ih)':'min(iw,ih)',scale=${d}:${d}:flags=lanczos,format=yuva420p[camsq]`,
    );
    filters.push(`[${maskIdx}:v]format=gray,scale=${d}:${d}[mask]`);
    filters.push(`[camsq][mask]alphamerge[cam]`);
    filters.push(`[base][cam]overlay=x=${bubble.x}:y=${bubble.y}:eof_action=pass:format=auto,format=yuv420p[vout]`);
    videoOut = 'vout';
    args.push('-loop', '1', '-framerate', String(fps), '-i', opts.maskPathFor(d));
  }

  const audioLabels: string[] = [];
  for (const a of audioInputs) {
    const idx = inputIndex++;
    const shift = delta(a);
    const chain = [
      'asetpts=PTS-STARTPTS',
      // async resampling fills timestamp gaps with silence and corrects drift.
      'aresample=48000:async=1000:first_pts=0',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    ];
    if (shift > 0) chain.push(`adelay=${Math.round(shift)}:all=1`);
    else if (shift < 0) chain.push(`atrim=start=${sec(-shift)}`, 'asetpts=PTS-STARTPTS');
    const label = `a${idx}`;
    filters.push(`[${idx}:a]${chain.join(',')}[${label}]`);
    audioLabels.push(label);
  }

  let audioOut: string | null = null;
  if (audioLabels.length === 1) {
    filters.push(`[${audioLabels[0]}]alimiter=limit=0.95:level=0,apad[aout]`);
    audioOut = 'aout';
  } else if (audioLabels.length > 1) {
    // normalize=0 keeps each source at full level (amix would otherwise halve them);
    // the limiter then prevents the sum from clipping.
    const weights = audioInputs.map((a) => (a.kind === 'mic' ? '1' : '0.8')).join(' ');
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0:weights='${weights}',` +
        `alimiter=limit=0.95:level=0,apad[aout]`,
    );
    audioOut = 'aout';
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', `[${videoOut}]`);
  if (audioOut) args.push('-map', `[${audioOut}]`);

  // The base video defines the output length; apad'ed audio is cut to match.
  const expectedDurationMs = base.durationMs ?? base.probe.durationMs;
  if (expectedDurationMs && expectedDurationMs > 0) args.push('-t', sec(expectedDurationMs));
  else if (audioOut) args.push('-shortest');

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(X264_CRF[opts.quality]),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-r', String(fps),
    '-g', String(fps * 2),
  );
  if (audioOut) args.push('-c:a', 'aac', '-b:a', AAC_BITRATE[opts.quality], '-ar', '48000', '-ac', '2');
  else args.push('-an');
  args.push('-max_muxing_queue_size', '4096', '-movflags', '+faststart', '-f', 'mp4', opts.outputPath);

  return {
    args,
    width,
    height,
    bubble,
    audioSources: audioInputs.map((a) => a.kind),
    expectedDurationMs: expectedDurationMs ?? null,
    warnings,
  };
}
