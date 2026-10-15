import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BloomError } from '@shared/ipc-contracts';
import type { ExportRequest, JobInfo } from '@shared/recording-types';
import { validateTrim } from '@shared/trim';
import type { JobManager } from '../media/job-manager';
import type { MediaService } from '../media/media-service';
import { partialPathFor, safeFileBaseName, uniqueFilePath } from '../storage/filenames';
import { fileSizeOrNull } from '../storage/paths';
import type { RecordingsRepo } from '../storage/recordings-repo';
import type { SettingsRepo } from '../storage/settings-repo';

export interface ExportServiceDeps {
  recordings: RecordingsRepo;
  settings: SettingsRepo;
  media: MediaService;
  jobs: JobManager;
  thumbnailsDir: string;
  emitLibraryChanged(reason: string): void;
}

/**
 * Trim/export jobs. Output is always written to a hidden `.partial` file and
 * renamed into place only after FFprobe verification. The original recording
 * is never modified unless destination is 'replace' and the user confirmed.
 */
export class ExportService {
  constructor(private readonly deps: ExportServiceDeps) {}

  /**
   * @param savePath For destination 'file': the path the user picked in the
   *   native Save dialog (the dialog runs in main, so the path is trusted).
   */
  start(req: ExportRequest, savePath: string | null): JobInfo {
    const { recordings, settings, media, jobs } = this.deps;
    const rec = recordings.get(req.recordingId);
    if (!rec) throw new BloomError('NOT_FOUND', 'Recording not found');
    if (rec.status !== 'ready') throw new BloomError('CONFLICT', 'This recording is not ready yet.');
    if (!fs.existsSync(rec.filePath)) throw new BloomError('NOT_FOUND', 'The source file is missing. It may have been moved or deleted.');
    const check = validateTrim(req.startMs, req.endMs, rec.durationMs);
    if (!check.ok) throw new BloomError('VALIDATION', check.error);
    if (req.destination === 'replace' && req.confirmReplace !== true) {
      throw new BloomError('VALIDATION', 'Replacing the original requires explicit confirmation.');
    }
    if (jobs.activeFor(rec.id) && req.destination === 'replace') {
      throw new BloomError('CONFLICT', 'Another job is already using this recording.');
    }

    let target: string;
    if (req.destination === 'file') {
      if (!savePath) throw new BloomError('VALIDATION', 'No destination file selected.');
      target = path.extname(savePath).toLowerCase() === '.mp4' ? path.resolve(savePath) : `${path.resolve(savePath)}.mp4`;
      if (path.resolve(target) === path.resolve(rec.filePath)) {
        throw new BloomError('VALIDATION', 'Choose “Replace original” to overwrite the source recording.');
      }
    } else if (req.destination === 'replace') {
      target = rec.filePath;
    } else {
      target = ''; // chosen when the job runs, so the name is still free
    }

    let partial: string | null = null;
    const sourceId = rec.id;
    const label =
      req.destination === 'replace' ? `Trimming “${rec.title}”` : req.destination === 'file' ? `Exporting “${rec.title}”` : `Saving trimmed copy of “${rec.title}”`;

    return jobs.enqueue({
      kind: 'export',
      label,
      recordingId: sourceId,
      run: async (ctx) => {
        const src = recordings.get(sourceId);
        if (!src || !fs.existsSync(src.filePath)) throw new BloomError('NOT_FOUND', 'The source file is missing.');
        let finalPath = target;
        if (req.destination === 'library') {
          const outDir = settings.get().outputDir;
          await fs.promises.mkdir(outDir, { recursive: true });
          finalPath = uniqueFilePath(outDir, safeFileBaseName(`${src.title} (trimmed)`), 'mp4');
        }
        partial = partialPathFor(finalPath);
        const probe = await media.trim(
          { input: src.filePath, output: partial, startMs: req.startMs, endMs: req.endMs, mode: req.mode, quality: req.quality },
          src.hasAudio,
          (p) => ctx.progress(p === null ? null : p * 0.95),
          ctx.signal,
        );

        if (req.destination === 'replace') {
          // Swap with a backup so the original is restorable if the rename fails.
          const backup = `${src.filePath}.bak-${Date.now()}`;
          await fs.promises.rename(src.filePath, backup);
          try {
            await fs.promises.rename(partial, src.filePath);
          } catch (err) {
            await fs.promises.rename(backup, src.filePath).catch(() => {});
            throw err;
          }
          partial = null;
          await fs.promises.rm(backup, { force: true }).catch(() => {});
          const thumb = await this.thumbnail(src.filePath, src.id, probe.durationMs, ctx.signal);
          recordings.update(src.id, {
            durationMs: probe.durationMs,
            width: probe.video?.width ?? null,
            height: probe.video?.height ?? null,
            fps: probe.video?.fps ?? null,
            fileSize: await fileSizeOrNull(src.filePath),
            videoCodec: probe.video?.codec ?? null,
            audioCodec: probe.audio?.codec ?? null,
            hasAudio: !!probe.audio,
            thumbnailPath: thumb ?? src.thumbnailPath,
          });
          this.deps.emitLibraryChanged('replaced');
          return { outputPath: src.filePath };
        }

        await fs.promises.rename(partial, finalPath);
        partial = null;

        if (req.destination === 'library') {
          const id = randomUUID();
          const thumb = await this.thumbnail(finalPath, id, probe.durationMs, ctx.signal);
          const now = Date.now();
          recordings.create({
            id,
            title: `${src.title} (trimmed)`.slice(0, 200),
            filePath: finalPath,
            thumbnailPath: thumb,
            status: 'ready',
            durationMs: probe.durationMs,
            width: probe.video?.width ?? null,
            height: probe.video?.height ?? null,
            fps: probe.video?.fps ?? null,
            fileSize: await fileSizeOrNull(finalPath),
            videoCodec: probe.video?.codec ?? null,
            audioCodec: probe.audio?.codec ?? null,
            hasAudio: !!probe.audio,
            hasCamera: src.hasCamera,
            sourceRecordingId: src.id,
            trimStartMs: req.startMs,
            trimEndMs: req.endMs,
            createdAt: now,
            updatedAt: now,
          });
          this.deps.emitLibraryChanged('exported');
        }
        ctx.progress(1);
        return { outputPath: finalPath };
      },
      cleanup: async () => {
        if (partial) await fs.promises.rm(partial, { force: true }).catch(() => {});
        partial = null;
      },
    });
  }

  private async thumbnail(file: string, id: string, durationMs: number | null, signal: AbortSignal): Promise<string | null> {
    const out = path.join(this.deps.thumbnailsDir, `${id}.jpg`);
    try {
      await this.deps.media.thumbnail(file, out, durationMs, signal);
      return out;
    } catch {
      return null;
    }
  }
}
