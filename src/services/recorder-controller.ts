import type { BloomApi } from '@shared/ipc-contracts';
import type {
  BubblePosition,
  BubbleSize,
  FrameRate,
  QualityPreset,
  RecordingMode,
  ResolutionPreset,
  StopRecordingResponse,
  TrackKind,
} from '@shared/recording-types';
import { bitrateFor, pickMimeType } from './media-support';

export interface RecorderConfig {
  mode: RecordingMode;
  sourceId: string | null;
  sourceName: string | null;
  resolution: ResolutionPreset;
  frameRate: FrameRate;
  quality: QualityPreset;
  bubblePosition: BubblePosition;
  bubbleSize: BubbleSize;
}

export type CaptureStreams = Partial<Record<TrackKind, MediaStream>>;

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'failed';

export type RecorderEvent =
  | { type: 'phase'; phase: RecorderPhase }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'source-ended'; kind: TrackKind };

export interface RecorderDeps {
  api: Pick<BloomApi, 'recording'>;
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  isTypeSupported: (mime: string) => boolean;
  now: () => number;
}

/** MediaRecorder timeslice: chunks are flushed to disk about once per second. */
export const TIMESLICE_MS = 1000;

interface Track {
  kind: TrackKind;
  recorder: MediaRecorder;
  /** Serialized writes so chunks reach disk in order. */
  writes: Promise<void>;
  stopped: Promise<void>;
}

export class RecorderStateError extends Error {}

/**
 * Drives one MediaRecorder per captured track (screen, camera, microphone,
 * system audio) and streams their chunks to the main process, which appends
 * them to disk. Recorders are started, paused and resumed together; each
 * recorder's actual start offset is reported so FFmpeg can align the tracks.
 *
 * Operations are guarded by the phase so duplicate or conflicting calls are
 * rejected rather than corrupting a session.
 */
export class RecorderController {
  private phase: RecorderPhase = 'idle';
  private tracks: Track[] = [];
  private sessionId: string | null = null;
  private activeMs = 0;
  private segmentStart: number | null = null;
  private failure: string | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly deps: RecorderDeps,
    private readonly onEvent: (e: RecorderEvent) => void = () => {},
  ) {}

  get currentPhase(): RecorderPhase {
    return this.phase;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Recording time excluding pauses. */
  elapsedMs(): number {
    return this.activeMs + (this.segmentStart !== null ? this.deps.now() - this.segmentStart : 0);
  }

  async start(config: RecorderConfig, streams: CaptureStreams): Promise<string> {
    if (this.phase !== 'idle') throw new RecorderStateError(`Cannot start while ${this.phase}`);
    this.setPhase('starting');
    try {
      const specs: Array<{ kind: TrackKind; stream: MediaStream; mimeType: string }> = [];
      for (const kind of ['screen', 'camera', 'mic', 'system'] as const) {
        const stream = streams[kind];
        if (!stream || stream.getTracks().every((t) => t.readyState === 'ended')) continue;
        const mimeType = pickMimeType(kind, this.deps.isTypeSupported);
        if (!mimeType) throw new Error(`This system cannot record ${kind === 'mic' || kind === 'system' ? 'audio' : 'video'} with MediaRecorder.`);
        specs.push({ kind, stream, mimeType });
      }

      const { sessionId } = await this.deps.api.recording.start({
        mode: config.mode,
        sourceId: config.sourceId,
        sourceName: config.sourceName,
        tracks: specs.map(({ kind, mimeType }) => ({ kind, mimeType })),
        bubblePosition: config.bubblePosition,
        bubbleSize: config.bubbleSize,
        quality: config.quality,
        frameRate: config.frameRate,
        resolution: config.resolution,
      });
      this.sessionId = sessionId;

      const t0 = this.deps.now();
      const startedOffsets: Array<Promise<void>> = [];
      for (const spec of specs) {
        const isVideo = spec.kind === 'screen' || spec.kind === 'camera';
        const recorder = this.deps.createRecorder(spec.stream, {
          mimeType: spec.mimeType,
          ...(isVideo
            ? { videoBitsPerSecond: bitrateFor(spec.kind, config.resolution, config.quality, config.frameRate) }
            : { audioBitsPerSecond: bitrateFor(spec.kind, config.resolution, config.quality, config.frameRate) }),
        });
        let resolveStopped!: () => void;
        const track: Track = { kind: spec.kind, recorder, writes: Promise.resolve(), stopped: new Promise((r) => (resolveStopped = r)) };

        recorder.ondataavailable = (e: BlobEvent) => {
          if (!e.data || e.data.size === 0) return;
          const blob = e.data;
          track.writes = track.writes.then(async () => {
            if (this.failure) return;
            const buf = new Uint8Array(await blob.arrayBuffer());
            try {
              await this.deps.api.recording.writeChunk(sessionId, spec.kind, buf);
            } catch (err) {
              // Main has already stopped the session and kept what was written.
              this.fail(err instanceof Error ? err.message : String(err), false);
            }
          });
        };
        recorder.onstop = () => resolveStopped();
        recorder.onerror = (ev: Event) => {
          const err = (ev as Event & { error?: DOMException }).error;
          this.fail(`Recording error (${spec.kind}): ${err?.message ?? 'unknown'}`, true);
        };
        startedOffsets.push(
          new Promise<void>((resolve) => {
            recorder.onstart = () => {
              void this.deps.api.recording.trackStarted(sessionId, spec.kind, Math.max(0, this.deps.now() - t0)).catch(() => {});
              resolve();
            };
          }),
        );

        // A source vanishing (shared window closed, device unplugged) is surfaced to the UI.
        for (const mt of spec.stream.getTracks()) {
          const onEnded = () => this.onEvent({ type: 'source-ended', kind: spec.kind });
          mt.addEventListener('ended', onEnded);
          this.cleanups.push(() => mt.removeEventListener('ended', onEnded));
        }
        this.tracks.push(track);
      }

      // Start every recorder in the same task so their timelines line up.
      for (const t of this.tracks) t.recorder.start(TIMESLICE_MS);
      this.segmentStart = this.deps.now();
      this.setPhase('recording');
      await Promise.race([Promise.all(startedOffsets), new Promise((r) => setTimeout(r, 2000))]);
      return sessionId;
    } catch (err) {
      await this.teardownAfterStartFailure(err);
      throw err;
    }
  }

  async pause(): Promise<void> {
    if (this.phase !== 'recording' || !this.sessionId) throw new RecorderStateError(`Cannot pause while ${this.phase}`);
    await this.deps.api.recording.pause(this.sessionId);
    for (const t of this.tracks) if (t.recorder.state === 'recording') t.recorder.pause();
    if (this.segmentStart !== null) this.activeMs += this.deps.now() - this.segmentStart;
    this.segmentStart = null;
    this.setPhase('paused');
  }

  async resume(): Promise<void> {
    if (this.phase !== 'paused' || !this.sessionId) throw new RecorderStateError(`Cannot resume while ${this.phase}`);
    await this.deps.api.recording.resume(this.sessionId);
    for (const t of this.tracks) if (t.recorder.state === 'paused') t.recorder.resume();
    this.segmentStart = this.deps.now();
    this.setPhase('recording');
  }

  /** Stops all recorders, waits until every chunk is on disk, then asks main to process the session. */
  async stop(title?: string): Promise<StopRecordingResponse> {
    if ((this.phase !== 'recording' && this.phase !== 'paused') || !this.sessionId) {
      throw new RecorderStateError(`Cannot stop while ${this.phase}`);
    }
    if (this.segmentStart !== null) this.activeMs += this.deps.now() - this.segmentStart;
    this.segmentStart = null;
    this.setPhase('stopping');
    await this.flushRecorders();
    if (this.failure) {
      this.setPhase('failed');
      throw new Error(this.failure);
    }
    try {
      const result = await this.deps.api.recording.stop(this.sessionId, title);
      this.setPhase('stopped');
      return result;
    } catch (err) {
      this.setPhase('failed');
      throw err;
    } finally {
      this.dispose();
    }
  }

  /** Stops recording without processing. The raw session stays recoverable unless `discard` is true. */
  async cancel(discard: boolean): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'stopped') return;
    const sessionId = this.sessionId;
    await this.flushRecorders();
    if (sessionId) {
      await this.deps.api.recording.abort(sessionId, 'Recording cancelled by the user.').catch(() => {});
      if (discard) await this.deps.api.recording.discard(sessionId).catch(() => {});
    }
    this.dispose();
    this.setPhase('idle');
  }

  private async flushRecorders(): Promise<void> {
    for (const t of this.tracks) {
      if (t.recorder.state !== 'inactive') {
        try {
          t.recorder.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    // A recorder whose source ended may never fire stop again; don't hang forever.
    await Promise.race([Promise.all(this.tracks.map((t) => t.stopped)), new Promise((r) => setTimeout(r, 5000))]);
    await Promise.all(this.tracks.map((t) => t.writes));
  }

  private fail(message: string, notifyMain: boolean): void {
    if (this.failure) return;
    this.failure = message;
    const sessionId = this.sessionId;
    for (const t of this.tracks) {
      if (t.recorder.state !== 'inactive') {
        try {
          t.recorder.stop();
        } catch {
          /* ignore */
        }
      }
    }
    if (notifyMain && sessionId) void this.deps.api.recording.abort(sessionId, message).catch(() => {});
    this.segmentStart = null;
    this.setPhase('failed');
    this.onEvent({ type: 'error', message, recoverable: true });
    this.dispose();
  }

  private async teardownAfterStartFailure(err: unknown): Promise<void> {
    for (const t of this.tracks) {
      try {
        if (t.recorder.state !== 'inactive') t.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.sessionId) {
      const id = this.sessionId;
      await this.deps.api.recording.abort(id, `Failed to start: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      await this.deps.api.recording.discard(id).catch(() => {});
    }
    this.dispose();
    this.sessionId = null;
    this.setPhase('idle');
  }

  private dispose(): void {
    for (const c of this.cleanups.splice(0)) c();
    for (const t of this.tracks) {
      t.recorder.ondataavailable = null;
      t.recorder.onerror = null;
    }
  }

  private setPhase(phase: RecorderPhase): void {
    this.phase = phase;
    this.onEvent({ type: 'phase', phase });
  }
}
