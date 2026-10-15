import { describe, expect, it, vi } from 'vitest';
import { JobManager, type JobContext } from '../../electron/media/job-manager';
import { MediaError } from '../../electron/media/errors';
import type { JobInfo } from '@shared/recording-types';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A job that runs until resolved or aborted, like an FFmpeg process. */
function abortableJob(onStart?: (ctx: JobContext) => void) {
  const gate = deferred();
  return {
    gate,
    run: (ctx: JobContext) =>
      new Promise<void>((resolve, reject) => {
        onStart?.(ctx);
        ctx.signal.addEventListener('abort', () => reject(new MediaError('CANCELLED', 'Cancelled')));
        gate.promise.then(resolve, reject);
      }),
  };
}

describe('media job manager', () => {
  it('runs jobs serially and reports progress', async () => {
    const updates: JobInfo[] = [];
    const jm = new JobManager((j) => updates.push(j));
    const order: string[] = [];
    const a = jm.enqueue({
      kind: 'compose',
      label: 'a',
      recordingId: 'r1',
      run: async (ctx) => {
        order.push('a-start');
        ctx.progress(0.5);
        await new Promise((r) => setTimeout(r, 20));
        order.push('a-end');
        return { outputPath: '/out/a.mp4' };
      },
    });
    const b = jm.enqueue({
      kind: 'export',
      label: 'b',
      recordingId: 'r2',
      run: async () => {
        order.push('b');
      },
    });
    expect(jm.get(b.id)?.status).toBe('queued');
    await jm.whenIdle();
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    expect(jm.get(a.id)).toMatchObject({ status: 'completed', progress: 1, outputPath: '/out/a.mp4', canRetry: false });
    expect(updates.some((u) => u.id === a.id && u.progress === 0.5)).toBe(true);
  });

  it('cancels running jobs, runs cleanup, and allows retry', async () => {
    const jm = new JobManager();
    const cleanup = vi.fn();
    let attempts = 0;
    const job1 = abortableJob(() => attempts++);
    const info = jm.enqueue({ kind: 'export', label: 'x', recordingId: 'r', run: job1.run, cleanup });
    await new Promise((r) => setTimeout(r, 5));
    expect(jm.get(info.id)?.status).toBe('running');
    expect(jm.activeFor('r')?.id).toBe(info.id);
    jm.cancel(info.id);
    await jm.whenIdle();
    expect(jm.get(info.id)).toMatchObject({ status: 'cancelled', error: null, canRetry: true });
    expect(cleanup).toHaveBeenCalledTimes(1);

    // Retry re-runs the same spec under the same id.
    const retried = jm.retry(info.id);
    expect(['queued', 'running']).toContain(retried.status);
    expect(retried.error).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    job1.gate.resolve();
    await jm.whenIdle();
    expect(attempts).toBe(2);
    expect(jm.get(info.id)?.status).toBe('completed');
  });

  it('cancels queued jobs without running them', async () => {
    const jm = new JobManager();
    const blocker = abortableJob();
    jm.enqueue({ kind: 'compose', label: 'block', recordingId: null, run: blocker.run });
    const run = vi.fn();
    const queued = jm.enqueue({ kind: 'compose', label: 'q', recordingId: null, run });
    jm.cancel(queued.id);
    blocker.gate.resolve();
    await jm.whenIdle();
    expect(run).not.toHaveBeenCalled();
    expect(jm.get(queued.id)?.status).toBe('cancelled');
  });

  it('records failures with their message and keeps processing the queue', async () => {
    const jm = new JobManager();
    const failed = jm.enqueue({
      kind: 'compose',
      label: 'f',
      recordingId: null,
      run: async () => {
        throw new MediaError('MEDIA', 'A source file is damaged');
      },
    });
    const ok = jm.enqueue({ kind: 'compose', label: 'ok', recordingId: null, run: async () => {} });
    await jm.whenIdle();
    expect(jm.get(failed.id)).toMatchObject({ status: 'failed', error: 'A source file is damaged', canRetry: true });
    expect(jm.get(ok.id)?.status).toBe('completed');
  });

  it('guards invalid operations', async () => {
    const jm = new JobManager();
    const done = jm.enqueue({ kind: 'compose', label: 'd', recordingId: null, run: async () => {} });
    await jm.whenIdle();
    expect(() => jm.retry(done.id)).toThrow(/Only failed/);
    expect(() => jm.cancel('nope')).toThrow(/not found/);
    const nr = jm.enqueue({
      kind: 'compose',
      label: 'nr',
      recordingId: null,
      retryable: false,
      run: async () => {
        throw new Error('x');
      },
    });
    await jm.whenIdle();
    expect(jm.get(nr.id)?.canRetry).toBe(false);
    expect(() => jm.retry(nr.id)).toThrow(/cannot be retried/);
    jm.dismiss(nr.id);
    expect(jm.get(nr.id)).toBeUndefined();
  });
});
