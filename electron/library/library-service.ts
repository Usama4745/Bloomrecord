import fs from 'node:fs';
import { BloomError } from '@shared/ipc-contracts';
import type { LibraryStats, ListRecordingsRequest, RecordingSummary } from '@shared/recording-types';
import type { JobManager } from '../media/job-manager';
import { freeSpace } from '../storage/paths';
import type { RecordingsRepo } from '../storage/recordings-repo';
import type { RecordingRow } from '../storage/schema';
import type { SettingsRepo } from '../storage/settings-repo';
import path from 'node:path';

export interface LibraryServiceDeps {
  recordings: RecordingsRepo;
  settings: SettingsRepo;
  jobs: JobManager;
  thumbnailsDir: string;
  /** Moves a file to the OS trash (falls back to deletion). */
  trash(file: string): Promise<void>;
  reveal(file: string): void;
  emitLibraryChanged(reason: string): void;
}

export const MEDIA_SCHEME = 'bloom-media';

export function mediaUrl(kind: 'recording' | 'thumbnail', id: string, version: number): string {
  return `${MEDIA_SCHEME}://${kind}/${id}?v=${version}`;
}

export class LibraryService {
  constructor(private readonly deps: LibraryServiceDeps) {}

  toSummary(row: RecordingRow): RecordingSummary {
    const exists = fs.existsSync(row.filePath);
    const fileMissing = row.status === 'ready' && !exists;
    const thumbExists = !!row.thumbnailPath && fs.existsSync(row.thumbnailPath);
    return {
      id: row.id,
      title: row.title,
      fileName: path.basename(row.filePath),
      durationMs: row.durationMs,
      width: row.width,
      height: row.height,
      fileSize: row.fileSize,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      hasCamera: row.hasCamera,
      hasAudio: row.hasAudio,
      sourceRecordingId: row.sourceRecordingId,
      sessionId: row.sessionId,
      fileMissing,
      mediaUrl: row.status === 'ready' && exists ? mediaUrl('recording', row.id, row.updatedAt) : null,
      thumbnailUrl: thumbExists ? mediaUrl('thumbnail', row.id, row.updatedAt) : null,
    };
  }

  list(req: ListRecordingsRequest): RecordingSummary[] {
    return this.deps.recordings.list(req).map((r) => this.toSummary(r));
  }

  get(id: string): RecordingSummary {
    return this.toSummary(this.requireRow(id));
  }

  rename(id: string, title: string): RecordingSummary {
    this.requireRow(id);
    const row = this.deps.recordings.update(id, { title })!;
    this.deps.emitLibraryChanged('renamed');
    return this.toSummary(row);
  }

  async delete(id: string, deleteFile: boolean): Promise<void> {
    const row = this.requireRow(id);
    if (this.deps.jobs.activeFor(id)) throw new BloomError('CONFLICT', 'This recording is being processed. Cancel the job first.');
    if (deleteFile && fs.existsSync(row.filePath)) {
      try {
        await this.deps.trash(row.filePath);
      } catch (err) {
        throw new BloomError('IO', `Could not delete the file: ${(err as Error).message}`);
      }
    }
    if (row.thumbnailPath && row.thumbnailPath.startsWith(this.deps.thumbnailsDir)) {
      await fs.promises.rm(row.thumbnailPath, { force: true }).catch(() => {});
    }
    this.deps.recordings.delete(id);
    this.deps.emitLibraryChanged('deleted');
  }

  reveal(id: string): void {
    const row = this.requireRow(id);
    if (!fs.existsSync(row.filePath)) throw new BloomError('NOT_FOUND', 'The file is missing. It may have been moved or deleted.');
    this.deps.reveal(row.filePath);
  }

  async stats(): Promise<LibraryStats> {
    const { count, totalBytes } = this.deps.recordings.stats();
    const outputDir = this.deps.settings.get().outputDir;
    return { recordingCount: count, totalBytes, outputDir, freeBytes: await freeSpace(outputDir) };
  }

  /** Resolves a recording's media file for the media protocol, or null if unavailable. */
  resolveMedia(kind: string, id: string): string | null {
    const row = this.deps.recordings.get(id);
    if (!row) return null;
    if (kind === 'recording') return row.status === 'ready' && fs.existsSync(row.filePath) ? row.filePath : null;
    if (kind === 'thumbnail') return row.thumbnailPath && fs.existsSync(row.thumbnailPath) ? row.thumbnailPath : null;
    return null;
  }

  private requireRow(id: string): RecordingRow {
    const row = this.deps.recordings.get(id);
    if (!row) throw new BloomError('NOT_FOUND', 'Recording not found');
    return row;
  }
}
