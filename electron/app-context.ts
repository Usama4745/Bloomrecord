import path from 'node:path';
import { shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import { IpcEvents, type IpcEvent, type IpcEventPayloads } from '@shared/ipc-contracts';
import type { Settings } from '@shared/recording-types';
import { createCapturePlatform, type CapturePlatform } from './capture/platform';
import { DisplayMediaBroker } from './capture/display-media';
import { ExportService } from './library/export-service';
import { LibraryService } from './library/library-service';
import { createLogger } from './logger';
import type { FfmpegBinaries } from './media/binaries';
import { JobManager } from './media/job-manager';
import { MediaService } from './media/media-service';
import { RecordingService } from './recording/recording-service';
import { ApprovedPaths } from './security/path-guard';
import type { TrustedOrigins } from './security/hardening';
import { openDatabase, type DatabaseHandle } from './storage/db';
import { createAppPaths, type AppPaths } from './storage/paths';
import { RecordingsRepo } from './storage/recordings-repo';
import { SessionsRepo } from './storage/sessions-repo';
import { SettingsRepo } from './storage/settings-repo';

export interface AppContext {
  paths: AppPaths;
  database: DatabaseHandle;
  recordingsRepo: RecordingsRepo;
  sessionsRepo: SessionsRepo;
  settings: SettingsRepo;
  media: MediaService;
  jobs: JobManager;
  recording: RecordingService;
  library: LibraryService;
  exports: ExportService;
  platform: CapturePlatform;
  broker: DisplayMediaBroker;
  origins: TrustedOrigins;
  approved: ApprovedPaths;
  log: (msg: string, err?: unknown) => void;
  onSettingsChanged(s: Settings): void;
}

export interface AppContextOptions {
  userData: string;
  defaultOutputDir: string;
  bins: FfmpegBinaries;
  origins: TrustedOrigins;
  send<E extends IpcEvent>(event: E, payload: IpcEventPayloads[E]): void;
  onSettingsChanged(s: Settings): void;
}

/** Composition root for the main process: wires storage, media engine and services together. */
export function createAppContext(opts: AppContextOptions): AppContext {
  const paths = createAppPaths(opts.userData);
  const log = createLogger(paths.logs);
  const database = openDatabase(paths.database);
  const recordingsRepo = new RecordingsRepo(database.db);
  const sessionsRepo = new SessionsRepo(database.db);
  const settings = new SettingsRepo(database.db, opts.defaultOutputDir);
  const media = new MediaService(opts.bins);
  const emitLibraryChanged = (reason: string) => opts.send(IpcEvents.libraryChanged, { reason });
  const jobs = new JobManager((job) => {
    opts.send(IpcEvents.jobUpdate, job);
    if (job.status === 'failed') log(`Job ${job.kind} failed: ${job.error}`);
  });

  const platform = createCapturePlatform(process.platform, process.arch, process.env, {
    getMediaAccessStatus: (kind) => systemPreferences.getMediaAccessStatus?.(kind) ?? 'unknown',
    askForMediaAccess: process.platform === 'darwin' ? (kind) => systemPreferences.askForMediaAccess(kind) : undefined,
    openExternal: (url) => shell.openExternal(url),
  });

  const approved = new ApprovedPaths();
  approved.approve(paths.userData);
  approved.approve(settings.get().outputDir);

  const recording = new RecordingService({
    sessions: sessionsRepo,
    recordings: recordingsRepo,
    settings,
    paths,
    media,
    jobs,
    emitStatus: (e) => opts.send(IpcEvents.recordingStatus, e),
    emitLibraryChanged,
  });

  const library = new LibraryService({
    recordings: recordingsRepo,
    settings,
    jobs,
    thumbnailsDir: paths.thumbnails,
    trash: async (file) => {
      try {
        await shell.trashItem(file);
      } catch {
        await fs.promises.rm(file);
      }
    },
    reveal: (file) => shell.showItemInFolder(path.resolve(file)),
    emitLibraryChanged,
  });

  const exports = new ExportService({ recordings: recordingsRepo, settings, media, jobs, thumbnailsDir: paths.thumbnails, emitLibraryChanged });

  return {
    paths,
    database,
    recordingsRepo,
    sessionsRepo,
    settings,
    media,
    jobs,
    recording,
    library,
    exports,
    platform,
    broker: new DisplayMediaBroker(platform),
    origins: opts.origins,
    approved,
    log,
    onSettingsChanged: (s) => {
      approved.approve(s.outputDir);
      opts.onSettingsChanged(s);
    },
  };
}
