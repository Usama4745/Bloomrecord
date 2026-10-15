import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BloomError } from '@shared/ipc-contracts';
import { activeDurationMs, isCapturing, isRecoverable, nextStatus, UNFINISHED_STATUSES, type SessionEvent } from '@shared/recording-state';
import type {
  InterruptedSession,
  PauseInterval,
  RecordingMode,
  RecordingStatusEvent,
  SessionStatus,
  StartRecordingRequest,
  StopRecordingResponse,
  TrackKind,
} from '@shared/recording-types';
import { startRecordingRequestSchema } from '@shared/validation';
import type { JobManager } from '../media/job-manager';
import type { MediaService } from '../media/media-service';
import { defaultRecordingTitle, partialPathFor, safeFileBaseName, uniqueFilePath } from '../storage/filenames';
import { fileSizeOrNull, freeSpace, type AppPaths } from '../storage/paths';
import type { RecordingsRepo } from '../storage/recordings-repo';
import type { SessionRow } from '../storage/schema';
import { parsePauses, type SessionsRepo } from '../storage/sessions-repo';
import type { SettingsRepo } from '../storage/settings-repo';
import { readManifest, writeManifest, type SessionManifest } from './manifest';
import { DiskFullError, MIN_FREE_BYTES, TrackWriter } from './track-writer';

export interface RecordingServiceDeps {
  sessions: SessionsRepo;
  recordings: RecordingsRepo;
  settings: SettingsRepo;
  paths: AppPaths;
  media: MediaService;
  jobs: JobManager;
  emitStatus(e: RecordingStatusEvent): void;
  emitLibraryChanged(reason: string): void;
  now?: () => number;
}

interface ActiveSession {
  id: string;
  status: SessionStatus;
  startedAt: number;
  pauses: PauseInterval[];
  writers: Map<TrackKind, TrackWriter>;
  lastPersist: number;
}

type SessionOptions = Omit<StartRecordingRequest, 'tracks'>;

function extensionFor(mime: string): string {
  if (/mp4/i.test(mime)) return 'mp4';
  if (/matroska/i.test(mime)) return 'mkv';
  return 'webm';
}

/**
 * Orchestrates capture sessions in the main process. The renderer owns the
 * MediaRecorders; this service owns state, files and recovery:
 *   start → chunks appended to per-track files → pause/resume → stop →
 *   compose job (FFmpeg) → library recording.
 * Every transition is persisted (SQLite + manifest.json) so a crash at any
 * point leaves a recoverable session.
 */
export class RecordingService {
  private active: ActiveSession | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RecordingServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  get activeSessionId(): string | null {
    return this.active?.id ?? null;
  }

  isCapturing(): boolean {
    return !!this.active && isCapturing(this.active.status);
  }

  async start(input: StartRecordingRequest): Promise<{ sessionId: string; createdAt: number }> {
    const req = startRecordingRequestSchema.parse(input);
    if (this.active) throw new BloomError('CONFLICT', 'A recording is already in progress.');

    const { sessions, paths, settings } = this.deps;
    const outputDir = settings.get().outputDir;
    for (const dir of [paths.sessions, outputDir]) {
      const free = await freeSpace(dir);
      if (free !== null && free < MIN_FREE_BYTES * 2) {
        throw new BloomError('DISK_FULL', `Not enough free disk space in ${dir} to start recording.`);
      }
    }

    const id = randomUUID();
    const tempDir = path.join(paths.sessions, id);
    await fs.promises.mkdir(tempDir, { recursive: true });
    const startedAt = this.now();
    const { tracks, ...options } = req;

    // Claim the slot before any await so a second start cannot race in.
    const active: ActiveSession = { id, status: 'recording', startedAt, pauses: [], writers: new Map(), lastPersist: startedAt };
    this.active = active;
    try {
      sessions.create({
        id,
        status: 'recording',
        mode: req.mode,
        optionsJson: JSON.stringify(options),
        pausesJson: '[]',
        tempDir,
        startedAt,
      });
      for (const t of tracks) {
        const file = path.join(tempDir, `${t.kind}.${extensionFor(t.mimeType)}`);
        sessions.addTrack(id, t.kind, file, t.mimeType);
        const writer = new TrackWriter(file);
        await writer.open();
        active.writers.set(t.kind, writer);
      }
      this.persistManifest(id);
    } catch (err) {
      this.active = null;
      for (const w of active.writers.values()) await w.close().catch(() => {});
      sessions.delete(id);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      throw err;
    }
    this.emit(active);
    return { sessionId: id, createdAt: startedAt };
  }

  async writeChunk(sessionId: string, kind: TrackKind, data: Uint8Array): Promise<void> {
    const s = this.requireActive(sessionId);
    if (!isCapturing(s.status)) throw new BloomError('CONFLICT', `Cannot write to a session that is ${s.status}`);
    const writer = s.writers.get(kind);
    if (!writer) throw new BloomError('VALIDATION', `Session has no ${kind} track`);
    try {
      await writer.append(data);
    } catch (err) {
      const diskFull = err instanceof DiskFullError;
      await this.abort(sessionId, diskFull ? err.message : `Could not write recording data: ${(err as Error).message}`);
      throw new BloomError(diskFull ? 'DISK_FULL' : 'IO', diskFull ? err.message : 'Could not write recording data to disk.');
    }
    const now = this.now();
    if (now - s.lastPersist > 5000) {
      s.lastPersist = now;
      for (const [k, w] of s.writers) this.deps.sessions.setTrackBytes(sessionId, k, w.bytesWritten);
      this.deps.sessions.update(sessionId, { activeDurationMs: activeDurationMs(s.startedAt, s.pauses, now) });
    }
  }

  trackStarted(sessionId: string, kind: TrackKind, offsetMs: number): void {
    const s = this.requireActive(sessionId);
    if (!s.writers.has(kind)) throw new BloomError('VALIDATION', `Session has no ${kind} track`);
    this.deps.sessions.setTrackOffset(sessionId, kind, offsetMs);
    this.persistManifest(sessionId);
  }

  pause(sessionId: string): RecordingStatusEvent {
    const s = this.requireActive(sessionId);
    this.transition(s, 'pause');
    s.pauses.push({ startedAt: this.now(), endedAt: null });
    this.persistState(s);
    return this.emit(s);
  }

  resume(sessionId: string): RecordingStatusEvent {
    const s = this.requireActive(sessionId);
    this.transition(s, 'resume');
    const open = s.pauses.at(-1);
    if (open && open.endedAt === null) open.endedAt = this.now();
    this.persistState(s);
    return this.emit(s);
  }

  /** Finalizes capture and queues compositing. The renderer must have flushed all chunks first. */
  async stop(sessionId: string, title?: string): Promise<StopRecordingResponse> {
    const s = this.requireActive(sessionId);
    this.transition(s, 'stop');
    const endedAt = this.now();
    const open = s.pauses.at(-1);
    if (open && open.endedAt === null) open.endedAt = endedAt;
    await this.closeWriters(s);
    const duration = activeDurationMs(s.startedAt, s.pauses, endedAt, endedAt);
    this.deps.sessions.update(sessionId, {
      status: 'stopping',
      endedAt,
      activeDurationMs: duration,
      pausesJson: JSON.stringify(s.pauses),
      title: title ?? null,
    });
    this.active = null;
    this.emit(s, duration);

    const result = this.queueCompose(sessionId, 'process');
    this.persistManifest(sessionId);
    return result;
  }

  /** Stops capture after an error. Raw files are kept so the session can be recovered. */
  async abort(sessionId: string, reason: string): Promise<void> {
    const s = this.active?.id === sessionId ? this.active : null;
    if (!s) {
      const row = this.deps.sessions.get(sessionId);
      if (!row) throw new BloomError('NOT_FOUND', 'Recording session not found');
      return; // already finished or aborted
    }
    const endedAt = this.now();
    const open = s.pauses.at(-1);
    if (open && open.endedAt === null) open.endedAt = endedAt;
    s.status = 'failed';
    this.active = null;
    await this.closeWriters(s);
    this.deps.sessions.update(sessionId, {
      status: 'failed',
      error: reason.slice(0, 1000),
      endedAt,
      activeDurationMs: activeDurationMs(s.startedAt, s.pauses, endedAt, endedAt),
      pausesJson: JSON.stringify(s.pauses),
    });
    this.persistManifest(sessionId);
    this.emit(s, undefined, reason);
  }

  listInterrupted(): InterruptedSession[] {
    const rows = this.deps.sessions.listByStatus(['interrupted', 'failed']);
    const out: InterruptedSession[] = [];
    for (const row of rows) {
      if (!fs.existsSync(row.tempDir)) continue;
      const tracks = this.deps.sessions.tracks(row.id);
      const bytes = tracks.reduce((n, t) => n + (fsSize(t.filePath) ?? 0), 0);
      const recording = this.deps.recordings.findBySession(row.id);
      if (recording && this.deps.jobs.activeFor(recording.id)) continue;
      out.push({
        sessionId: row.id,
        startedAt: row.startedAt,
        mode: row.mode as RecordingMode,
        status: row.status as SessionStatus,
        activeDurationMs: row.activeDurationMs ?? 0,
        bytesWritten: bytes,
        tracks: tracks.filter((t) => (fsSize(t.filePath) ?? 0) > 0).map((t) => t.kind as TrackKind),
        error: row.error,
        recordingId: recording?.id ?? null,
      });
    }
    return out;
  }

  recover(sessionId: string): StopRecordingResponse {
    const row = this.deps.sessions.get(sessionId);
    if (!row) throw new BloomError('NOT_FOUND', 'Recording session not found');
    if (!isRecoverable(row.status as SessionStatus)) {
      throw new BloomError('CONFLICT', `This session is ${row.status} and cannot be recovered.`);
    }
    if (!fs.existsSync(row.tempDir)) throw new BloomError('NOT_FOUND', 'The raw recording files for this session no longer exist.');
    const existing = this.deps.recordings.findBySession(sessionId);
    if (existing && this.deps.jobs.activeFor(existing.id)) throw new BloomError('CONFLICT', 'This recording is already being processed.');
    return this.queueCompose(sessionId, 'recover');
  }

  async discard(sessionId: string): Promise<void> {
    const row = this.deps.sessions.get(sessionId);
    if (!row) throw new BloomError('NOT_FOUND', 'Recording session not found');
    if (!isRecoverable(row.status as SessionStatus)) throw new BloomError('CONFLICT', `Cannot discard a session that is ${row.status}`);
    const rec = this.deps.recordings.findBySession(sessionId);
    if (rec && this.deps.jobs.activeFor(rec.id)) throw new BloomError('CONFLICT', 'This recording is being processed.');
    await fs.promises.rm(row.tempDir, { recursive: true, force: true });
    this.deps.sessions.update(sessionId, { status: nextStatus(row.status as SessionStatus, 'discard') });
    if (rec && rec.status !== 'ready') {
      this.deps.recordings.delete(rec.id);
      this.deps.emitLibraryChanged('discarded');
    }
  }

  /**
   * Startup recovery: sessions left recording/processing by a crash become
   * 'interrupted', orphaned session folders with a valid manifest are
   * re-registered, and recordings stuck in 'processing' become 'failed'.
   */
  recoverAfterCrash(): { interrupted: number; imported: number } {
    const { sessions, recordings, paths } = this.deps;
    let interrupted = 0;
    for (const row of sessions.listByStatus(UNFINISHED_STATUSES)) {
      sessions.update(row.id, {
        status: 'interrupted',
        error: row.error ?? 'BloomRecord closed before this recording finished.',
        activeDurationMs: row.activeDurationMs ?? estimateDuration(row),
      });
      interrupted++;
    }
    for (const rec of recordings.listProcessing()) {
      recordings.update(rec.id, { status: 'failed', error: 'Processing was interrupted. Retry to finish it.' });
    }

    let imported = 0;
    const known = new Set(sessions.listAll().map((s) => s.id));
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(paths.sessions);
    } catch {
      /* none */
    }
    for (const name of dirs) {
      if (known.has(name)) continue;
      const dir = path.join(paths.sessions, name);
      const m = readManifest(dir);
      if (!m || m.sessionId !== name) continue;
      this.importManifest(dir, m);
      imported++;
    }
    return { interrupted, imported };
  }

  private importManifest(dir: string, m: SessionManifest): void {
    const { sessions } = this.deps;
    sessions.create({
      id: m.sessionId,
      status: 'interrupted',
      mode: m.mode,
      optionsJson: JSON.stringify(m.options),
      pausesJson: JSON.stringify(m.pauses),
      tempDir: dir,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      error: 'Recovered from an interrupted session.',
    });
    for (const t of m.tracks) {
      const file = path.join(dir, t.file);
      sessions.addTrack(m.sessionId, t.kind, file, t.mimeType);
      if (t.offsetMs !== null) sessions.setTrackOffset(m.sessionId, t.kind, t.offsetMs);
    }
  }

  // -------------------------------------------------------------------------

  private queueCompose(sessionId: string, event: SessionEvent): StopRecordingResponse {
    const { sessions, recordings, jobs, settings } = this.deps;
    const row = sessions.get(sessionId)!;
    const status = nextStatus(row.status as SessionStatus, event);
    const options = JSON.parse(row.optionsJson) as SessionOptions;
    const title = row.title ?? defaultRecordingTitle(new Date(row.startedAt));
    const tracks = sessions.tracks(sessionId);

    let recording = recordings.findBySession(sessionId);
    const now = this.now();
    if (!recording) {
      recording = recordings.create({
        id: randomUUID(),
        title,
        filePath: path.join(settings.get().outputDir, `${safeFileBaseName(title)}.mp4`),
        status: 'processing',
        sessionId,
        hasCamera: options.mode !== 'screen' && tracks.some((t) => t.kind === 'camera'),
        hasAudio: tracks.some((t) => t.kind === 'mic' || t.kind === 'system'),
        createdAt: row.startedAt,
        updatedAt: now,
      });
    } else {
      recordings.update(recording.id, { status: 'processing', error: null });
    }
    sessions.update(sessionId, { status, recordingId: recording.id, error: null });
    this.deps.emitLibraryChanged('processing');

    const recordingId = recording.id;
    let partial: string | null = null;
    const job = jobs.enqueue({
      kind: 'compose',
      label: `Processing “${recording.title}”`,
      recordingId,
      run: async (ctx) => {
        const s = sessions.get(sessionId);
        if (!s) throw new BloomError('NOT_FOUND', 'Recording session was removed');
        if (isRecoverable(s.status as SessionStatus)) sessions.update(sessionId, { status: nextStatus(s.status as SessionStatus, 'recover') });
        recordings.update(recordingId, { status: 'processing', error: null });
        this.deps.emitLibraryChanged('processing');
        try {
          const rec = recordings.get(recordingId)!;
          const outDir = settings.get().outputDir;
          await fs.promises.mkdir(outDir, { recursive: true });
          const finalPath = uniqueFilePath(outDir, safeFileBaseName(rec.title), 'mp4');
          partial = partialPathFor(finalPath);
          const raw = sessions.tracks(sessionId).map((t) => ({
            kind: t.kind as TrackKind,
            path: t.filePath,
            offsetMs: t.startOffsetMs ?? 0,
          }));
          const { plan, probe } = await this.deps.media.compose(
            raw,
            { ...options, outputPath: partial, workDir: s.tempDir },
            (p) => ctx.progress(p === null ? null : p * 0.97),
            ctx.signal,
          );
          await fs.promises.rename(partial, finalPath);
          partial = null;

          const thumb = path.join(this.deps.paths.thumbnails, `${recordingId}.jpg`);
          let thumbnailPath: string | null = thumb;
          try {
            await this.deps.media.thumbnail(finalPath, thumb, probe.durationMs, ctx.signal);
          } catch {
            thumbnailPath = null;
          }
          recordings.update(recordingId, {
            status: 'ready',
            error: plan.warnings.length ? plan.warnings.join(' ') : null,
            filePath: finalPath,
            thumbnailPath,
            durationMs: probe.durationMs,
            width: probe.video?.width ?? null,
            height: probe.video?.height ?? null,
            fps: probe.video?.fps ?? null,
            fileSize: await fileSizeOrNull(finalPath),
            videoCodec: probe.video?.codec ?? null,
            audioCodec: probe.audio?.codec ?? null,
            hasAudio: !!probe.audio,
            hasCamera: !!plan.bubble || options.mode === 'camera',
          });
          sessions.update(sessionId, { status: 'completed', error: null });
          // Sources are deleted only after the final file is verified.
          await fs.promises.rm(s.tempDir, { recursive: true, force: true }).catch(() => {});
          ctx.progress(1);
          this.deps.emitLibraryChanged('ready');
          return { outputPath: finalPath };
        } catch (err) {
          const cancelled = ctx.signal.aborted;
          const message = cancelled ? 'Processing was cancelled. Your raw recording is kept; retry to finish it.' : (err as Error).message;
          recordings.update(recordingId, { status: 'failed', error: message });
          const cur = sessions.get(sessionId);
          if (cur && cur.status === 'processing') sessions.update(sessionId, { status: 'failed', error: message });
          this.deps.emitLibraryChanged('failed');
          throw err;
        }
      },
      cleanup: async () => {
        if (partial) await fs.promises.rm(partial, { force: true }).catch(() => {});
        partial = null;
      },
    });
    return { recordingId, jobId: job.id };
  }

  private requireActive(sessionId: string): ActiveSession {
    if (!this.active || this.active.id !== sessionId) throw new BloomError('NOT_FOUND', 'No active recording with that id');
    return this.active;
  }

  private transition(s: ActiveSession, event: SessionEvent): void {
    s.status = nextStatus(s.status, event);
  }

  private async closeWriters(s: ActiveSession): Promise<void> {
    for (const [kind, w] of s.writers) {
      try {
        await w.close();
      } catch {
        /* keep going: other tracks may still be fine */
      }
      this.deps.sessions.setTrackBytes(s.id, kind, w.bytesWritten);
    }
  }

  private persistState(s: ActiveSession): void {
    this.deps.sessions.update(s.id, {
      status: s.status,
      pausesJson: JSON.stringify(s.pauses),
      activeDurationMs: activeDurationMs(s.startedAt, s.pauses, this.now()),
    });
    this.persistManifest(s.id);
  }

  private persistManifest(sessionId: string): void {
    const row = this.deps.sessions.get(sessionId);
    if (!row || !fs.existsSync(row.tempDir)) return;
    try {
      writeManifest(row.tempDir, {
        version: 1,
        sessionId,
        status: row.status,
        mode: row.mode as RecordingMode,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        pauses: parsePauses(row.pausesJson),
        options: JSON.parse(row.optionsJson) as Record<string, unknown>,
        tracks: this.deps.sessions.tracks(sessionId).map((t) => ({
          kind: t.kind as TrackKind,
          file: path.basename(t.filePath),
          mimeType: t.mimeType,
          offsetMs: t.startOffsetMs,
        })),
      });
    } catch {
      /* the database remains the source of truth */
    }
  }

  private emit(s: ActiveSession, durationOverride?: number, error?: string): RecordingStatusEvent {
    let bytes = 0;
    for (const w of s.writers.values()) bytes += w.bytesWritten;
    const event: RecordingStatusEvent = {
      sessionId: s.id,
      status: s.status,
      activeDurationMs: durationOverride ?? activeDurationMs(s.startedAt, s.pauses, this.now()),
      bytesWritten: bytes,
      error: error ?? null,
    };
    this.deps.emitStatus(event);
    return event;
  }
}

function fsSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function estimateDuration(row: SessionRow): number {
  const end = row.endedAt ?? row.updatedAt;
  return activeDurationMs(row.startedAt, parsePauses(row.pausesJson), end, end);
}
