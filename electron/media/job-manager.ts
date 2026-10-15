import { randomUUID } from 'node:crypto';
import type { JobInfo, JobKind } from '@shared/recording-types';
import { isCancelled, MediaError } from './errors';

export interface JobContext {
  signal: AbortSignal;
  progress(fraction: number | null): void;
}

export interface JobResult {
  outputPath?: string | null;
}

export interface JobSpec {
  kind: JobKind;
  label: string;
  recordingId: string | null;
  run(ctx: JobContext): Promise<JobResult | void>;
  /** Called after a failure or cancellation so partial outputs can be removed. */
  cleanup?(): Promise<void> | void;
  retryable?: boolean;
}

interface JobEntry {
  info: JobInfo;
  spec: JobSpec;
  controller: AbortController | null;
}

const MAX_FINISHED = 50;

/**
 * Serial queue for CPU-heavy media jobs (one FFmpeg process at a time).
 * Jobs report progress, can be cancelled while queued or running, and failed
 * or cancelled jobs can be retried with the same spec.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly queue: string[] = [];
  private running: string | null = null;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly onUpdate: (job: JobInfo) => void = () => {}) {}

  enqueue(spec: JobSpec): JobInfo {
    const id = randomUUID();
    const info: JobInfo = {
      id,
      kind: spec.kind,
      label: spec.label,
      recordingId: spec.recordingId,
      status: 'queued',
      progress: 0,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      outputPath: null,
      canRetry: false,
    };
    this.jobs.set(id, { info, spec, controller: null });
    this.queue.push(id);
    this.emit(id);
    this.pump();
    return { ...info };
  }

  get(id: string): JobInfo | undefined {
    const e = this.jobs.get(id);
    return e ? { ...e.info } : undefined;
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((e) => ({ ...e.info })).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Active (queued/running) job for a recording, if any. */
  activeFor(recordingId: string): JobInfo | undefined {
    return this.list().find((j) => j.recordingId === recordingId && (j.status === 'queued' || j.status === 'running'));
  }

  cancel(id: string): void {
    const e = this.jobs.get(id);
    if (!e) throw new MediaError('NOT_FOUND', 'Job not found');
    if (e.info.status === 'queued') {
      const idx = this.queue.indexOf(id);
      if (idx >= 0) this.queue.splice(idx, 1);
      this.finish(e, 'cancelled', null);
      void Promise.resolve(e.spec.cleanup?.()).catch(() => {});
    } else if (e.info.status === 'running') {
      e.controller?.abort();
    }
  }

  retry(id: string): JobInfo {
    const e = this.jobs.get(id);
    if (!e) throw new MediaError('NOT_FOUND', 'Job not found');
    if (e.info.status !== 'failed' && e.info.status !== 'cancelled') {
      throw new MediaError('MEDIA', 'Only failed or cancelled jobs can be retried');
    }
    if (e.spec.retryable === false) throw new MediaError('MEDIA', 'This job cannot be retried');
    Object.assign(e.info, { status: 'queued', progress: 0, error: null, finishedAt: null, canRetry: false });
    e.controller = null;
    this.queue.push(id);
    this.emit(id);
    this.pump();
    return { ...e.info };
  }

  /** Removes a finished job from the list. */
  dismiss(id: string): void {
    const e = this.jobs.get(id);
    if (!e) return;
    if (e.info.status === 'queued' || e.info.status === 'running') throw new MediaError('MEDIA', 'Cancel the job before dismissing it');
    this.jobs.delete(id);
  }

  /** Cancels everything (app shutdown). */
  cancelAll(): void {
    for (const id of [...this.queue]) this.cancel(id);
    if (this.running) this.jobs.get(this.running)?.controller?.abort();
  }

  /** Resolves when no job is queued or running. */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) {
      for (const w of this.idleWaiters.splice(0)) w();
      return;
    }
    const e = this.jobs.get(id);
    if (!e) return this.pump();
    this.running = id;
    const controller = new AbortController();
    e.controller = controller;
    e.info.status = 'running';
    e.info.progress = 0;
    this.emit(id);

    let lastEmit = 0;
    const ctx: JobContext = {
      signal: controller.signal,
      progress: (fraction) => {
        if (e.info.status !== 'running') return;
        e.info.progress = fraction === null ? null : Math.min(1, Math.max(0, fraction));
        const now = Date.now();
        if (now - lastEmit > 150 || fraction === 1) {
          lastEmit = now;
          this.emit(id);
        }
      },
    };

    void (async () => {
      try {
        const result = await e.spec.run(ctx);
        if (controller.signal.aborted) throw new MediaError('CANCELLED', 'Cancelled');
        e.info.outputPath = result?.outputPath ?? null;
        this.finish(e, 'completed', null);
      } catch (err) {
        const cancelled = controller.signal.aborted || isCancelled(err);
        try {
          await e.spec.cleanup?.();
        } catch {
          /* best effort */
        }
        this.finish(e, cancelled ? 'cancelled' : 'failed', cancelled ? null : err instanceof Error ? err.message : String(err));
      } finally {
        this.running = null;
        this.prune();
        this.pump();
      }
    })();
  }

  private finish(e: JobEntry, status: 'completed' | 'failed' | 'cancelled', error: string | null): void {
    e.info.status = status;
    e.info.error = error;
    e.info.finishedAt = Date.now();
    if (status === 'completed') e.info.progress = 1;
    e.info.canRetry = status !== 'completed' && e.spec.retryable !== false;
    e.controller = null;
    this.emit(e.info.id);
  }

  private prune(): void {
    const finished = this.list().filter((j) => j.finishedAt !== null);
    for (const j of finished.slice(MAX_FINISHED)) this.jobs.delete(j.id);
  }

  private emit(id: string): void {
    const e = this.jobs.get(id);
    if (e) this.onUpdate({ ...e.info });
  }
}
