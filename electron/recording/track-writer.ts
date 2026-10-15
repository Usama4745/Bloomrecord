import fs from 'node:fs';
import path from 'node:path';
import { freeSpace } from '../storage/paths';

/** Below this much free space, recording stops rather than corrupting the disk state. */
export const MIN_FREE_BYTES = 256 * 1024 * 1024;
const SPACE_CHECK_INTERVAL_BYTES = 32 * 1024 * 1024;

export class DiskFullError extends Error {
  constructor(message = 'Not enough free disk space to continue recording.') {
    super(message);
    this.name = 'DiskFullError';
  }
}

/**
 * Appends MediaRecorder chunks to a file as they arrive, so a recording is
 * never held in memory and survives a crash up to the last chunk. Writes are
 * serialized; free space is checked periodically.
 */
export class TrackWriter {
  private handle: fs.promises.FileHandle | null = null;
  private chain: Promise<void> = Promise.resolve();
  private written = 0;
  private sinceCheck = 0;
  private failed: Error | null = null;

  constructor(
    readonly filePath: string,
    private readonly minFreeBytes = MIN_FREE_BYTES,
    private readonly checkFree: (dir: string) => Promise<number | null> = freeSpace,
  ) {}

  get bytesWritten(): number {
    return this.written;
  }

  async open(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    this.handle = await fs.promises.open(this.filePath, 'a');
    this.written = (await this.handle.stat()).size;
  }

  append(data: Uint8Array): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.failed) throw this.failed;
      if (!this.handle) throw new Error('Track file is not open');
      if (data.byteLength === 0) return;
      this.sinceCheck += data.byteLength;
      if (this.sinceCheck >= SPACE_CHECK_INTERVAL_BYTES || this.written === 0) {
        this.sinceCheck = 0;
        const free = await this.checkFree(path.dirname(this.filePath));
        if (free !== null && free < this.minFreeBytes) throw (this.failed = new DiskFullError());
      }
      try {
        let offset = 0;
        while (offset < data.byteLength) {
          const { bytesWritten } = await this.handle.write(data, offset, data.byteLength - offset);
          offset += bytesWritten;
        }
        this.written += data.byteLength;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        this.failed = e.code === 'ENOSPC' ? new DiskFullError() : e;
        throw this.failed;
      }
    });
    // Keep the chain alive after a failure so later appends reject with the same error.
    this.chain = next.catch(() => {});
    return next;
  }

  /** Waits for pending writes, flushes to disk and closes. Safe to call twice. */
  async close(): Promise<void> {
    await this.chain;
    const h = this.handle;
    this.handle = null;
    if (h) {
      try {
        await h.sync();
      } catch {
        /* not fatal */
      }
      await h.close();
    }
  }
}
