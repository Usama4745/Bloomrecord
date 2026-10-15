import fs from 'node:fs';
import path from 'node:path';
import { planCompose, type ComposeInput, type ComposeOptions, type ComposePlan } from './compose';
import { MediaError } from './errors';
import { writeCircleMask } from './mask';
import { measureDurationMs, probeMedia, type MediaProbe } from './probe';
import { runProcess } from './process-runner';
import { progressReporter } from './progress';
import { buildThumbnailArgs, buildTrimArgs, thumbnailTimeMs, type TrimArgsOptions } from './trim';
import type { FfmpegBinaries } from './binaries';
import type { TrackKind } from '@shared/recording-types';

export interface RawTrack {
  kind: TrackKind;
  path: string;
  offsetMs: number;
}

export interface VerifyExpectations {
  audio: boolean;
  minDurationMs?: number;
  expectedDurationMs?: number | null;
}

type Progress = (fraction: number | null) => void;

/**
 * Media engine facade over the bundled FFmpeg/FFprobe: stream inspection,
 * compositing, trimming, thumbnails and output verification. Every operation
 * accepts an AbortSignal; cancellation kills the FFmpeg process.
 */
export class MediaService {
  constructor(readonly bins: FfmpegBinaries) {}

  probe(file: string, signal?: AbortSignal): Promise<MediaProbe> {
    return probeMedia(this.bins.ffprobe, file, signal);
  }

  measureDuration(file: string, signal?: AbortSignal): Promise<number | null> {
    return measureDurationMs(this.bins.ffmpeg, file, signal);
  }

  /** Inspects each raw track; unreadable tracks are returned with empty probes so the planner can skip them. */
  async inspectTracks(tracks: RawTrack[], signal?: AbortSignal): Promise<ComposeInput[]> {
    const out: ComposeInput[] = [];
    for (const t of tracks) {
      const empty: MediaProbe = { formatName: 'unknown', durationMs: null, sizeBytes: null, video: null, audio: null };
      let size = 0;
      try {
        size = (await fs.promises.stat(t.path)).size;
      } catch {
        /* missing */
      }
      if (size === 0) {
        out.push({ ...t, probe: empty, durationMs: null });
        continue;
      }
      try {
        const probe = await this.probe(t.path, signal);
        const needsVideo = t.kind === 'screen' || t.kind === 'camera';
        // Always measure: MediaRecorder WebM has no header duration, and a truncated
        // (interrupted) file may carry a header duration longer than its actual data.
        const durationMs = (await this.measureDuration(t.path, signal).catch(() => null)) ?? probe.durationMs;
        out.push({
          ...t,
          probe: needsVideo ? { ...probe, audio: null } : { ...probe, video: null },
          durationMs,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        out.push({ ...t, probe: empty, durationMs: null });
      }
    }
    return out;
  }

  /** Composites raw tracks into a verified MP4 at `opts.outputPath`. */
  async compose(
    tracks: RawTrack[],
    opts: Omit<ComposeOptions, 'maskPathFor'> & { workDir: string },
    onProgress: Progress,
    signal?: AbortSignal,
  ): Promise<{ plan: ComposePlan; probe: MediaProbe }> {
    const inputs = await this.inspectTracks(tracks, signal);
    const plan = planCompose(inputs, {
      ...opts,
      maskPathFor: (d) => {
        const p = path.join(opts.workDir, `mask-${d}.pgm`);
        if (!fs.existsSync(p)) writeCircleMask(p, d);
        return p;
      },
    });
    await runProcess(this.bins.ffmpeg, plan.args, {
      signal,
      onStdoutLine: progressReporter(plan.expectedDurationMs, onProgress),
    });
    const probe = await this.verifyOutput(opts.outputPath, {
      audio: plan.audioSources.length > 0,
      expectedDurationMs: plan.expectedDurationMs,
    });
    return { plan, probe };
  }

  async trim(o: TrimArgsOptions, expectAudio: boolean, onProgress: Progress, signal?: AbortSignal): Promise<MediaProbe> {
    await runProcess(this.bins.ffmpeg, buildTrimArgs(o), {
      signal,
      onStdoutLine: progressReporter(o.endMs - o.startMs, onProgress),
    });
    return this.verifyOutput(o.output, { audio: expectAudio, expectedDurationMs: o.endMs - o.startMs });
  }

  async thumbnail(input: string, output: string, durationMs: number | null, signal?: AbortSignal): Promise<void> {
    await runProcess(this.bins.ffmpeg, buildThumbnailArgs(input, output, thumbnailTimeMs(durationMs)), {
      signal,
      timeoutMs: 60_000,
    });
    if (!fs.existsSync(output)) throw new MediaError('MEDIA', 'Thumbnail was not created');
  }

  /** Confirms the output is a playable H.264 MP4 of plausible duration. */
  async verifyOutput(file: string, expect: VerifyExpectations, signal?: AbortSignal): Promise<MediaProbe> {
    let probe: MediaProbe;
    try {
      probe = await this.probe(file, signal);
    } catch (err) {
      if (err instanceof MediaError && err.code === 'CANCELLED') throw err;
      throw new MediaError('MEDIA', 'The exported file could not be read back for verification.');
    }
    if (!probe.video) throw new MediaError('MEDIA', 'The exported file has no video stream.');
    if (probe.video.codec !== 'h264') throw new MediaError('MEDIA', `Unexpected video codec in output: ${probe.video.codec}`);
    if (expect.audio && !probe.audio) throw new MediaError('MEDIA', 'The exported file is missing its audio track.');
    const min = expect.minDurationMs ?? 100;
    if (!probe.durationMs || probe.durationMs < min) throw new MediaError('MEDIA', 'The exported file is empty or too short.');
    if (expect.expectedDurationMs && expect.expectedDurationMs > 2000) {
      // Allow generous slack for keyframe-snapped stream copies and container rounding.
      const ratio = probe.durationMs / expect.expectedDurationMs;
      if (ratio < 0.8) throw new MediaError('MEDIA', 'The exported file is shorter than expected; processing may have stopped early.');
    }
    return probe;
  }

  async versions(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
    const first = async (bin: string) => {
      try {
        const { stdout } = await runProcess(bin, ['-version'], { collectStdout: true, timeoutMs: 10_000 });
        return stdout.split(/\r?\n/)[0]?.trim() ?? null;
      } catch {
        return null;
      }
    };
    return { ffmpeg: await first(this.bins.ffmpeg), ffprobe: await first(this.bins.ffprobe) };
  }
}
