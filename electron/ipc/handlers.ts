import { app, dialog, shell, type BrowserWindow } from 'electron';
import { IpcChannels as C } from '@shared/ipc-contracts';
import {
  abortRecordingRequestSchema,
  deleteRecordingRequestSchema,
  exportRequestSchema,
  jobIdRequestSchema,
  listRecordingsRequestSchema,
  listSourcesRequestSchema,
  mediaPermissionSchema,
  prepareSourceRequestSchema,
  recordingIdRequestSchema,
  renameRecordingRequestSchema,
  sessionRequestSchema,
  settingsPatchSchema,
  startRecordingRequestSchema,
  stopRecordingRequestSchema,
  trackStartedRequestSchema,
  writeChunkRequestSchema,
} from '@shared/validation';
import type { Diagnostics } from '@shared/recording-types';
import type { AppContext } from '../app-context';
import { listCaptureSources } from '../capture/display-media';
import { cleanupTemporaryFiles } from '../storage/cleanup';
import { importBackgroundImage, readBackgroundImage } from '../library/background-images';
import { directorySize } from '../storage/paths';
import { createRegistrar } from './handle';

export function registerIpcHandlers(ctx: AppContext, getWindow: () => BrowserWindow | null): void {
  const handle = createRegistrar(ctx.origins, ctx.log);
  const { recording, library, exports, jobs, settings, platform, broker } = ctx;

  // --- Capture -------------------------------------------------------------
  handle(C.captureListSources, listSourcesRequestSchema, async ({ types }) => {
    const exclude = new Set<string>();
    const win = getWindow();
    if (win) exclude.add(win.getMediaSourceId());
    return listCaptureSources(types, exclude);
  });
  handle(C.capturePrepareSource, prepareSourceRequestSchema, ({ sourceId, systemAudio }) => {
    broker.prepare(sourceId, systemAudio && platform.capabilities().systemAudio);
  });
  handle(C.capturePlatform, null, () => platform.capabilities());
  handle(C.capturePermissionStatus, mediaPermissionSchema, (kind) => platform.permissionStatus(kind));
  handle(C.captureRequestPermission, mediaPermissionSchema, (kind) => platform.requestPermission(kind));
  handle(C.captureOpenPermissionSettings, mediaPermissionSchema, (kind) => platform.openPermissionSettings(kind));

  // --- Recording -----------------------------------------------------------
  handle(C.recordingStart, startRecordingRequestSchema, (req) => recording.start(req));
  handle(C.recordingWriteChunk, writeChunkRequestSchema, ({ sessionId, kind, data }) => recording.writeChunk(sessionId, kind, data));
  handle(C.recordingTrackStarted, trackStartedRequestSchema, ({ sessionId, kind, offsetMs }) =>
    recording.trackStarted(sessionId, kind, offsetMs),
  );
  handle(C.recordingPause, sessionRequestSchema, ({ sessionId }) => recording.pause(sessionId));
  handle(C.recordingResume, sessionRequestSchema, ({ sessionId }) => recording.resume(sessionId));
  handle(C.recordingStop, stopRecordingRequestSchema, ({ sessionId, title }) => recording.stop(sessionId, title));
  handle(C.recordingAbort, abortRecordingRequestSchema, ({ sessionId, reason }) => recording.abort(sessionId, reason));
  handle(C.recordingListInterrupted, null, () => recording.listInterrupted());
  handle(C.recordingRecover, sessionRequestSchema, ({ sessionId }) => recording.recover(sessionId));
  handle(C.recordingDiscard, sessionRequestSchema, ({ sessionId }) => recording.discard(sessionId));

  // --- Library -------------------------------------------------------------
  handle(C.libraryList, listRecordingsRequestSchema, (req) => library.list(req));
  handle(C.libraryGet, recordingIdRequestSchema, ({ id }) => library.get(id));
  handle(C.libraryRename, renameRecordingRequestSchema, ({ id, title }) => library.rename(id, title));
  handle(C.libraryDelete, deleteRecordingRequestSchema, ({ id, deleteFile }) => library.delete(id, deleteFile));
  handle(C.libraryReveal, recordingIdRequestSchema, ({ id }) => library.reveal(id));
  handle(C.libraryStats, null, () => library.stats());

  // --- Jobs ----------------------------------------------------------------
  handle(C.jobsList, null, () => jobs.list());
  handle(C.jobsExport, exportRequestSchema, async (req) => {
    let savePath: string | null = null;
    if (req.destination === 'file') {
      const rec = library.get(req.recordingId);
      const win = getWindow();
      const opts = {
        title: 'Export recording',
        defaultPath: `${rec.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')}.mp4`,
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'] as Array<'createDirectory' | 'showOverwriteConfirmation'>,
      };
      const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (result.canceled || !result.filePath) return null;
      savePath = result.filePath;
      ctx.approved.approve(savePath);
    }
    return exports.start(req, savePath ? ctx.approved.assert(savePath, 'Export destination') : null);
  });
  handle(C.jobsCancel, jobIdRequestSchema, ({ jobId }) => jobs.cancel(jobId));
  handle(C.jobsRetry, jobIdRequestSchema, ({ jobId }) => jobs.retry(jobId));
  handle(C.jobsDismiss, jobIdRequestSchema, ({ jobId }) => jobs.dismiss(jobId));

  // --- Settings ------------------------------------------------------------
  handle(C.settingsGet, null, () => settings.get());
  handle(C.settingsUpdate, settingsPatchSchema, (patch) => {
    const next = settings.update(patch);
    ctx.onSettingsChanged(next);
    return next;
  });
  handle(C.settingsChooseOutputDir, null, async () => {
    const win = getWindow();
    const opts = {
      title: 'Choose recordings folder',
      defaultPath: settings.get().outputDir,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return null;
    ctx.approved.approve(dir);
    const next = settings.setOutputDir(dir);
    ctx.onSettingsChanged(next);
    return next;
  });
  handle(C.settingsOpenOutputDir, null, async () => {
    const dir = settings.get().outputDir;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });
  handle(C.settingsChooseBackgroundImage, null, async () => {
    const win = getWindow();
    const opts = {
      title: 'Choose a background image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile'] as Array<'openFile'>,
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    const fileName = await importBackgroundImage(file, ctx.paths.backgrounds);
    settings.setBackgroundCustomImage(fileName);
    const next = settings.update({ backgroundEffect: 'image', backgroundPreset: 'custom' });
    ctx.onSettingsChanged(next);
    return next;
  });
  handle(C.settingsGetBackgroundImage, null, () => readBackgroundImage(ctx.paths.backgrounds, settings.get().backgroundCustomImage));
  handle(C.settingsCleanupTemp, null, () =>
    cleanupTemporaryFiles({
      paths: ctx.paths,
      sessions: ctx.sessionsRepo,
      recordings: ctx.recordingsRepo,
      outputDir: settings.get().outputDir,
      activeSessionId: recording.activeSessionId,
      jobsRunning: jobs.list().some((j) => j.status === 'running' || j.status === 'queued'),
    }),
  );
  handle(C.settingsDiagnostics, null, async (): Promise<Diagnostics> => {
    const v = await ctx.media.versions();
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      ffmpegPath: ctx.media.bins.ffmpeg,
      ffmpegVersion: v.ffmpeg,
      ffprobeVersion: v.ffprobe,
      userDataDir: ctx.paths.userData,
      databasePath: ctx.paths.database,
      tempDir: ctx.paths.sessions,
      tempBytes: await directorySize(ctx.paths.sessions),
    };
  });
}
