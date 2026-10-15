import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingStatusEvent, StartRecordingRequest } from '@shared/recording-types';
import { BloomError } from '@shared/ipc-contracts';
import { openDatabase, type DatabaseHandle } from '../../electron/storage/db';
import { createAppPaths, type AppPaths } from '../../electron/storage/paths';
import { RecordingsRepo } from '../../electron/storage/recordings-repo';
import { SessionsRepo } from '../../electron/storage/sessions-repo';
import { SettingsRepo } from '../../electron/storage/settings-repo';
import { MediaService } from '../../electron/media/media-service';
import { JobManager } from '../../electron/media/job-manager';
import { RecordingService } from '../../electron/recording/recording-service';
import { LibraryService } from '../../electron/library/library-service';
import { ExportService } from '../../electron/library/export-service';
import { cleanupTemporaryFiles } from '../../electron/storage/cleanup';
import { bins, hasFfmpeg, makeAudioWebm, makeVideoWebm, tmpDir } from '../helpers/media';

const describeMedia = hasFfmpeg ? describe : describe.skip;

let fixtures: { screen: Buffer; camera: Buffer; mic: Buffer };

beforeAll(() => {
  if (!hasFfmpeg) return;
  const dir = tmpDir('bloom-fixtures-');
  fixtures = {
    screen: fs.readFileSync(makeVideoWebm(path.join(dir, 's.webm'), 'testsrc2=s=1280x720:r=30:d=4')),
    camera: fs.readFileSync(makeVideoWebm(path.join(dir, 'c.webm'), 'testsrc=s=640x480:r=30:d=4')),
    mic: fs.readFileSync(makeAudioWebm(path.join(dir, 'm.webm'), "aevalsrc='0.3*sin(2*PI*440*t)':s=48000:d=4")),
  };
});

interface Harness {
  db: DatabaseHandle;
  paths: AppPaths;
  outputDir: string;
  sessions: SessionsRepo;
  recordings: RecordingsRepo;
  settings: SettingsRepo;
  media: MediaService;
  jobs: JobManager;
  service: RecordingService;
  library: LibraryService;
  exports: ExportService;
  statuses: RecordingStatusEvent[];
  trash: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
}

function makeHarness(existing?: { root: string; db: DatabaseHandle }): Harness {
  const root = existing?.root ?? tmpDir('bloom-app-');
  const paths = createAppPaths(path.join(root, 'userData'));
  const outputDir = path.join(root, 'Videos', 'BloomRecord');
  const db = existing?.db ?? openDatabase(paths.database);
  const sessions = new SessionsRepo(db.db);
  const recordings = new RecordingsRepo(db.db);
  const settings = new SettingsRepo(db.db, outputDir);
  const media = new MediaService(bins);
  const jobs = new JobManager();
  const statuses: RecordingStatusEvent[] = [];
  const emitLibraryChanged = () => {};
  const service = new RecordingService({ sessions, recordings, settings, paths, media, jobs, emitStatus: (e) => statuses.push(e), emitLibraryChanged });
  const trash = vi.fn(async (f: string) => fs.promises.rm(f));
  const reveal = vi.fn();
  const library = new LibraryService({ recordings, settings, jobs, thumbnailsDir: paths.thumbnails, trash, reveal, emitLibraryChanged });
  const exports = new ExportService({ recordings, settings, media, jobs, thumbnailsDir: paths.thumbnails, emitLibraryChanged });
  return { db, paths, outputDir, sessions, recordings, settings, media, jobs, service, library, exports, statuses, trash, reveal };
}

const screenCamReq: StartRecordingRequest = {
  mode: 'screen-camera',
  sourceId: 'screen:0:0',
  sourceName: 'Screen 1',
  tracks: [
    { kind: 'screen', mimeType: 'video/webm;codecs=vp8' },
    { kind: 'camera', mimeType: 'video/webm;codecs=vp8' },
    { kind: 'mic', mimeType: 'audio/webm;codecs=opus' },
  ],
  bubblePosition: 'bottom-right',
  bubbleSize: 'medium',
  quality: 'low',
  frameRate: 30,
  resolution: '720p',
};

/** Feeds a file in MediaRecorder-sized slices, interleaving tracks like real recorders do. */
async function feed(h: Harness, sessionId: string, tracks: Array<['screen' | 'camera' | 'mic', Buffer]>, fraction = 1) {
  const slice = 32 * 1024;
  const limits = tracks.map(([, b]) => Math.floor(b.length * fraction));
  for (let off = 0; tracks.some((_, i) => off < limits[i]!); off += slice) {
    for (const [i, [kind, buf]] of tracks.entries()) {
      if (off < limits[i]!) await h.service.writeChunk(sessionId, kind, buf.subarray(off, Math.min(off + slice, limits[i]!)));
    }
  }
}

describeMedia('recording → processing → library flow (real FFmpeg + SQLite)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  it('records, pauses, resumes, stops and produces a verified library recording', async () => {
    const { sessionId } = await h.service.start(screenCamReq);
    const tempDir = path.join(h.paths.sessions, sessionId);
    expect(fs.existsSync(path.join(tempDir, 'manifest.json'))).toBe(true);
    h.service.trackStarted(sessionId, 'screen', 0);
    h.service.trackStarted(sessionId, 'camera', 25);
    h.service.trackStarted(sessionId, 'mic', 10);

    await feed(h, sessionId, [['screen', fixtures.screen], ['camera', fixtures.camera], ['mic', fixtures.mic]], 0.5);
    // Data is on disk progressively, before stop.
    expect(fs.statSync(path.join(tempDir, 'screen.webm')).size).toBeGreaterThan(0);

    const paused = h.service.pause(sessionId);
    expect(paused.status).toBe('paused');
    expect(() => h.service.pause(sessionId)).toThrow(/Cannot pause/);
    expect(h.service.resume(sessionId).status).toBe('recording');
    await feed(
      h,
      sessionId,
      [
        ['screen', fixtures.screen.subarray(Math.floor(fixtures.screen.length * 0.5))],
        ['camera', fixtures.camera.subarray(Math.floor(fixtures.camera.length * 0.5))],
        ['mic', fixtures.mic.subarray(Math.floor(fixtures.mic.length * 0.5))],
      ],
    );

    const { recordingId, jobId } = await h.service.stop(sessionId, 'My first demo');
    await expect(h.service.writeChunk(sessionId, 'screen', new Uint8Array(1))).rejects.toThrow(/No active recording/);
    expect(h.library.get(recordingId).status).toBe('processing');
    await h.jobs.whenIdle();

    expect(h.jobs.get(jobId)?.status).toBe('completed');
    const summary = h.library.get(recordingId);
    expect(summary).toMatchObject({ status: 'ready', title: 'My first demo', width: 1280, height: 720, hasCamera: true, hasAudio: true, fileMissing: false });
    expect(summary.fileName).toBe('My first demo.mp4');
    expect(summary.durationMs).toBeGreaterThan(3500);
    expect(summary.mediaUrl).toMatch(/^bloom-media:\/\/recording\//);
    expect(summary.thumbnailUrl).toMatch(/^bloom-media:\/\/thumbnail\//);
    const row = h.recordings.get(recordingId)!;
    expect(path.dirname(row.filePath)).toBe(h.outputDir);
    expect(fs.existsSync(row.filePath)).toBe(true);
    // Raw sources are removed only after success; no partial files remain.
    expect(fs.existsSync(tempDir)).toBe(false);
    expect(fs.readdirSync(h.outputDir).filter((f) => f.includes('.partial'))).toEqual([]);
    expect(h.sessions.get(sessionId)?.status).toBe('completed');
    expect(h.statuses.map((s) => s.status)).toEqual(['recording', 'paused', 'recording', 'stopping']);
    expect(h.library.list({ search: 'first' })).toHaveLength(1);
    expect((await h.library.stats()).recordingCount).toBe(1);
  });

  it('prevents duplicate starts and validates requests', async () => {
    const { sessionId } = await h.service.start(screenCamReq);
    await expect(h.service.start(screenCamReq)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.service.start({ ...screenCamReq, mode: 'screen' })).rejects.toThrow();
    await expect(h.service.writeChunk(sessionId, 'system', new Uint8Array(1))).rejects.toThrow(/no system track/);
    await h.service.abort(sessionId, 'test');
    // Slot is free again.
    const second = await h.service.start(screenCamReq);
    await h.service.abort(second.sessionId, 'test');
  });

  it('keeps raw files when processing fails, lists the session as recoverable, and discards it', async () => {
    const { sessionId } = await h.service.start({ ...screenCamReq, mode: 'screen', tracks: [{ kind: 'screen', mimeType: 'video/webm' }] });
    await h.service.writeChunk(sessionId, 'screen', new TextEncoder().encode('this is not a video'));
    const { recordingId, jobId } = await h.service.stop(sessionId);
    await h.jobs.whenIdle();
    expect(h.jobs.get(jobId)).toMatchObject({ status: 'failed', canRetry: true });
    expect(h.library.get(recordingId)).toMatchObject({ status: 'failed', mediaUrl: null });
    expect(h.library.get(recordingId).error).toMatch(/screen recording is missing/);
    expect(fs.existsSync(path.join(h.paths.sessions, sessionId, 'screen.webm'))).toBe(true);
    const interrupted = h.service.listInterrupted();
    expect(interrupted.map((s) => s.sessionId)).toEqual([sessionId]);
    expect(interrupted[0]).toMatchObject({ status: 'failed', recordingId, tracks: ['screen'] });

    // Retrying the job re-runs processing (and fails again on bad data).
    h.jobs.retry(jobId);
    await h.jobs.whenIdle();
    expect(h.jobs.get(jobId)?.status).toBe('failed');

    await h.service.discard(sessionId);
    expect(fs.existsSync(path.join(h.paths.sessions, sessionId))).toBe(false);
    expect(h.recordings.get(recordingId)).toBeUndefined();
    expect(h.sessions.get(sessionId)?.status).toBe('discarded');
    await expect(h.service.discard(sessionId)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('recovers a session interrupted by a crash (app restart)', async () => {
    const root = path.dirname(h.paths.userData);
    const { sessionId } = await h.service.start({
      ...screenCamReq,
      mode: 'screen',
      tracks: [
        { kind: 'screen', mimeType: 'video/webm' },
        { kind: 'mic', mimeType: 'audio/webm' },
      ],
    });
    h.service.pause(sessionId);
    h.service.resume(sessionId);
    // Only part of the recording reached disk before the "crash".
    await feed(h, sessionId, [['screen', fixtures.screen], ['mic', fixtures.mic]], 0.7);

    // Simulate a restart: new services over the same database and folders.
    const restarted = makeHarness({ root, db: h.db });
    expect(restarted.service.recoverAfterCrash()).toEqual({ interrupted: 1, imported: 0 });
    const list = restarted.service.listInterrupted();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId, status: 'interrupted', tracks: ['screen', 'mic'] });
    expect(list[0]!.bytesWritten).toBeGreaterThan(0);

    const { recordingId } = restarted.service.recover(sessionId);
    expect(() => restarted.service.recover(sessionId)).toThrow(/cannot be recovered|already being processed/);
    await restarted.jobs.whenIdle();
    const rec = restarted.library.get(recordingId);
    expect(rec.status).toBe('ready');
    expect(rec.durationMs).toBeGreaterThan(1000);
    expect(restarted.service.listInterrupted()).toHaveLength(0);
  });

  it('re-imports orphaned sessions from their manifest when the database row is lost', async () => {
    const { sessionId } = await h.service.start({ ...screenCamReq, mode: 'screen', tracks: [{ kind: 'screen', mimeType: 'video/webm' }] });
    h.service.trackStarted(sessionId, 'screen', 0);
    await feed(h, sessionId, [['screen', fixtures.screen]]);
    h.sessions.delete(sessionId); // DB lost the row; files + manifest remain

    const restarted = makeHarness({ root: path.dirname(h.paths.userData), db: h.db });
    expect(restarted.service.recoverAfterCrash().imported).toBe(1);
    const { recordingId } = restarted.service.recover(sessionId);
    await restarted.jobs.whenIdle();
    expect(restarted.library.get(recordingId).status).toBe('ready');
  });

  it('marks recordings stuck in processing as failed after a crash and lets them be retried', async () => {
    const { sessionId } = await h.service.start({ ...screenCamReq, mode: 'screen', tracks: [{ kind: 'screen', mimeType: 'video/webm' }] });
    await feed(h, sessionId, [['screen', fixtures.screen]]);
    const { recordingId, jobId } = await h.service.stop(sessionId);
    h.jobs.cancel(jobId); // processing interrupted (cancelled mid-flight / app quit)
    await h.jobs.whenIdle();
    expect(h.library.get(recordingId)).toMatchObject({ status: 'failed' });
    expect(h.library.get(recordingId).error).toMatch(/cancelled/i);
    expect(fs.readdirSync(h.outputDir).filter((f) => f.includes('.partial'))).toEqual([]);

    const restarted = makeHarness({ root: path.dirname(h.paths.userData), db: h.db });
    restarted.service.recoverAfterCrash();
    restarted.service.recover(sessionId);
    await restarted.jobs.whenIdle();
    expect(restarted.library.get(recordingId).status).toBe('ready');
  });

  describe('library and export', () => {
    let recordingId: string;
    beforeEach(async () => {
      const { sessionId } = await h.service.start({
        ...screenCamReq,
        mode: 'screen',
        tracks: [
          { kind: 'screen', mimeType: 'video/webm' },
          { kind: 'mic', mimeType: 'audio/webm' },
        ],
      });
      await feed(h, sessionId, [['screen', fixtures.screen], ['mic', fixtures.mic]]);
      ({ recordingId } = await h.service.stop(sessionId, 'Source clip'));
      await h.jobs.whenIdle();
    });

    it('renames, reveals and deletes recordings', async () => {
      expect(h.library.rename(recordingId, 'Renamed clip').title).toBe('Renamed clip');
      h.library.reveal(recordingId);
      expect(h.reveal).toHaveBeenCalledWith(h.recordings.get(recordingId)!.filePath);
      const file = h.recordings.get(recordingId)!.filePath;
      await h.library.delete(recordingId, true);
      expect(h.trash).toHaveBeenCalledWith(file);
      expect(fs.existsSync(file)).toBe(false);
      expect(() => h.library.get(recordingId)).toThrow(BloomError);
    });

    it('handles files that were moved or deleted outside the app', async () => {
      fs.rmSync(h.recordings.get(recordingId)!.filePath);
      const s = h.library.get(recordingId);
      expect(s).toMatchObject({ fileMissing: true, mediaUrl: null });
      expect(() => h.library.reveal(recordingId)).toThrow(/missing/);
      expect(() => h.exports.start({ recordingId, startMs: 0, endMs: 1000, mode: 'fast', quality: 'low', destination: 'library' }, null)).toThrow(
        /missing/,
      );
      expect(h.library.resolveMedia('recording', recordingId)).toBeNull();
      // Removing it from the library without the file works.
      await h.library.delete(recordingId, false);
      expect(h.library.list({})).toHaveLength(0);
    });

    it('exports a trimmed copy into the library without touching the original', async () => {
      const original = h.recordings.get(recordingId)!;
      const originalBytes = fs.readFileSync(original.filePath);
      const job = h.exports.start({ recordingId, startMs: 1000, endMs: 3000, mode: 'accurate', quality: 'low', destination: 'library' }, null);
      await h.jobs.whenIdle();
      expect(h.jobs.get(job.id)?.status).toBe('completed');
      const copy = h.library.list({}).find((r) => r.sourceRecordingId === recordingId)!;
      expect(copy.title).toBe('Source clip (trimmed)');
      expect(copy.durationMs).toBeGreaterThan(1800);
      expect(copy.durationMs).toBeLessThan(2300);
      expect(copy.hasAudio).toBe(true);
      expect(fs.readFileSync(original.filePath).equals(originalBytes)).toBe(true);
    });

    it('exports to a chosen file with stream copy', async () => {
      const dest = path.join(tmpDir(), 'export');
      const job = h.exports.start({ recordingId, startMs: 0, endMs: 2000, mode: 'fast', quality: 'high', destination: 'file' }, dest);
      await h.jobs.whenIdle();
      expect(h.jobs.get(job.id)).toMatchObject({ status: 'completed', outputPath: `${dest}.mp4` });
      expect(fs.existsSync(`${dest}.mp4`)).toBe(true);
      expect(() =>
        h.exports.start(
          { recordingId, startMs: 0, endMs: 2000, mode: 'fast', quality: 'high', destination: 'file' },
          h.recordings.get(recordingId)!.filePath,
        ),
      ).toThrow(/Replace original/);
    });

    it('replaces the original only with explicit confirmation', async () => {
      expect(() =>
        h.exports.start({ recordingId, startMs: 0, endMs: 2000, mode: 'accurate', quality: 'low', destination: 'replace' }, null),
      ).toThrow(/confirmation/);
      const before = h.recordings.get(recordingId)!;
      h.exports.start({ recordingId, startMs: 500, endMs: 2500, mode: 'accurate', quality: 'low', destination: 'replace', confirmReplace: true }, null);
      await h.jobs.whenIdle();
      const after = h.recordings.get(recordingId)!;
      expect(after.filePath).toBe(before.filePath);
      expect(after.durationMs!).toBeLessThan(2300);
      expect(fs.readdirSync(h.outputDir).filter((f) => f.includes('.bak-') || f.includes('.partial'))).toEqual([]);
    });

    it('rejects invalid trim ranges', () => {
      expect(() => h.exports.start({ recordingId, startMs: 0, endMs: 100, mode: 'fast', quality: 'low', destination: 'library' }, null)).toThrow(
        /at least/,
      );
      expect(() => h.exports.start({ recordingId, startMs: 0, endMs: 60_000, mode: 'fast', quality: 'low', destination: 'library' }, null)).toThrow(
        /past the end/,
      );
    });

    it('recovers from a failed export via retry, and cancellation removes partial output', async () => {
      const file = h.recordings.get(recordingId)!.filePath;
      const hidden = `${file}.moved`;
      const job = h.exports.start({ recordingId, startMs: 0, endMs: 3000, mode: 'accurate', quality: 'low', destination: 'library' }, null);
      fs.renameSync(file, hidden); // source disappears before the job runs → failure
      await h.jobs.whenIdle();
      expect(h.jobs.get(job.id)).toMatchObject({ status: 'failed', canRetry: true });
      fs.renameSync(hidden, file);
      h.jobs.retry(job.id);
      await h.jobs.whenIdle();
      expect(h.jobs.get(job.id)?.status).toBe('completed');

      const cancelled = h.exports.start({ recordingId, startMs: 0, endMs: 3900, mode: 'accurate', quality: 'high', destination: 'library' }, null);
      setTimeout(() => h.jobs.cancel(cancelled.id), 30);
      await h.jobs.whenIdle();
      const status = h.jobs.get(cancelled.id)?.status;
      expect(['cancelled', 'completed']).toContain(status); // very fast machines may finish first
      expect(fs.readdirSync(h.outputDir).filter((f) => f.includes('.partial'))).toEqual([]);
    });

    it('cleans up temporary files but never recoverable sessions', async () => {
      const { sessionId } = await h.service.start({ ...screenCamReq, mode: 'screen', tracks: [{ kind: 'screen', mimeType: 'video/webm' }] });
      await h.service.writeChunk(sessionId, 'screen', fixtures.screen.subarray(0, 1000));
      await h.service.abort(sessionId, 'simulated failure');
      const junk = path.join(h.paths.sessions, 'not-a-session');
      fs.mkdirSync(junk);
      fs.writeFileSync(path.join(junk, 'x.bin'), Buffer.alloc(10));
      fs.writeFileSync(path.join(h.paths.thumbnails, '00000000-0000-0000-0000-000000000000.jpg'), Buffer.alloc(5));
      fs.writeFileSync(path.join(h.outputDir, '.Stale.partial.mp4'), Buffer.alloc(7));

      const result = await cleanupTemporaryFiles({
        paths: h.paths,
        sessions: h.sessions,
        recordings: h.recordings,
        outputDir: h.outputDir,
        activeSessionId: null,
        jobsRunning: false,
      });
      expect(result).toEqual({ removedFiles: 3, freedBytes: 22 });
      expect(fs.existsSync(junk)).toBe(false);
      expect(fs.existsSync(path.join(h.paths.sessions, sessionId, 'screen.webm'))).toBe(true);
      expect(h.library.get(recordingId).status).toBe('ready');
    });
  });
});
