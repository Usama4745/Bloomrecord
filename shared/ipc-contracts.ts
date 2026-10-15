import type {
  CaptureSource,
  CleanupResult,
  Diagnostics,
  ExportRequest,
  InterruptedSession,
  JobInfo,
  LibraryStats,
  ListRecordingsRequest,
  MediaPermission,
  PermissionStatus,
  PlatformCapabilities,
  RecordingStatusEvent,
  RecordingSummary,
  Settings,
  SettingsPatch,
  ShortcutAction,
  StartRecordingRequest,
  StartRecordingResponse,
  StopRecordingResponse,
  TrackKind,
} from './recording-types';

/** Every invoke channel the renderer can reach. Anything not listed here is unreachable. */
export const IpcChannels = {
  captureListSources: 'capture:list-sources',
  capturePrepareSource: 'capture:prepare-source',
  capturePlatform: 'capture:platform',
  capturePermissionStatus: 'capture:permission-status',
  captureRequestPermission: 'capture:request-permission',
  captureOpenPermissionSettings: 'capture:open-permission-settings',

  recordingStart: 'recording:start',
  recordingWriteChunk: 'recording:write-chunk',
  recordingTrackStarted: 'recording:track-started',
  recordingPause: 'recording:pause',
  recordingResume: 'recording:resume',
  recordingStop: 'recording:stop',
  recordingAbort: 'recording:abort',
  recordingListInterrupted: 'recording:list-interrupted',
  recordingRecover: 'recording:recover',
  recordingDiscard: 'recording:discard',

  libraryList: 'library:list',
  libraryGet: 'library:get',
  libraryRename: 'library:rename',
  libraryDelete: 'library:delete',
  libraryReveal: 'library:reveal',
  libraryStats: 'library:stats',

  jobsList: 'jobs:list',
  jobsExport: 'jobs:export',
  jobsCancel: 'jobs:cancel',
  jobsRetry: 'jobs:retry',
  jobsDismiss: 'jobs:dismiss',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChooseOutputDir: 'settings:choose-output-dir',
  settingsCleanupTemp: 'settings:cleanup-temp',
  settingsDiagnostics: 'settings:diagnostics',
  settingsOpenOutputDir: 'settings:open-output-dir',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

/** Events main pushes to the renderer. */
export const IpcEvents = {
  recordingStatus: 'event:recording-status',
  jobUpdate: 'event:job-update',
  libraryChanged: 'event:library-changed',
  shortcut: 'event:shortcut',
} as const;

export type IpcEvent = (typeof IpcEvents)[keyof typeof IpcEvents];

export interface IpcEventPayloads {
  [IpcEvents.recordingStatus]: RecordingStatusEvent;
  [IpcEvents.jobUpdate]: JobInfo;
  [IpcEvents.libraryChanged]: { reason: string };
  [IpcEvents.shortcut]: { action: ShortcutAction };
}

/** All handlers resolve to this envelope so errors keep a clean code and message across the bridge. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: IpcErrorCode; message: string } };

export type IpcErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PERMISSION'
  | 'DISK_FULL'
  | 'IO'
  | 'MEDIA'
  | 'CANCELLED'
  | 'INTERNAL';

export class BloomError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BloomError';
  }
}

const CODE_PREFIX = /^\[bloom:([A-Z_]+)\] /;

export function encodeIpcError(code: IpcErrorCode, message: string): string {
  return `[bloom:${code}] ${message}`;
}

/** Recovers the code and human message from an error thrown by `window.bloom`. */
export function decodeIpcError(err: unknown): { code: IpcErrorCode; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron may prefix "Error invoking remote method '...': Error: ".
  const idx = raw.indexOf('[bloom:');
  const msg = idx >= 0 ? raw.slice(idx) : raw;
  const m = CODE_PREFIX.exec(msg);
  if (m) return { code: m[1] as IpcErrorCode, message: msg.slice(m[0].length) };
  return { code: 'INTERNAL', message: raw };
}

/** The narrow API exposed to the renderer as `window.bloom`. */
export interface BloomApi {
  capture: {
    listSources(types: Array<'screen' | 'window'>): Promise<CaptureSource[]>;
    /** Tells main which source the next getDisplayMedia() call should capture. */
    prepareSource(sourceId: string, systemAudio: boolean): Promise<void>;
    platform(): Promise<PlatformCapabilities>;
    permissionStatus(kind: MediaPermission): Promise<PermissionStatus>;
    requestPermission(kind: MediaPermission): Promise<PermissionStatus>;
    openPermissionSettings(kind: MediaPermission): Promise<void>;
  };
  recording: {
    start(req: StartRecordingRequest): Promise<StartRecordingResponse>;
    writeChunk(sessionId: string, kind: TrackKind, data: Uint8Array): Promise<void>;
    trackStarted(sessionId: string, kind: TrackKind, offsetMs: number): Promise<void>;
    pause(sessionId: string): Promise<RecordingStatusEvent>;
    resume(sessionId: string): Promise<RecordingStatusEvent>;
    stop(sessionId: string, title?: string): Promise<StopRecordingResponse>;
    abort(sessionId: string, reason: string): Promise<void>;
    listInterrupted(): Promise<InterruptedSession[]>;
    recover(sessionId: string): Promise<StopRecordingResponse>;
    discard(sessionId: string): Promise<void>;
  };
  library: {
    list(req: ListRecordingsRequest): Promise<RecordingSummary[]>;
    get(id: string): Promise<RecordingSummary>;
    rename(id: string, title: string): Promise<RecordingSummary>;
    delete(id: string, deleteFile: boolean): Promise<void>;
    reveal(id: string): Promise<void>;
    stats(): Promise<LibraryStats>;
  };
  jobs: {
    list(): Promise<JobInfo[]>;
    /** Resolves null if the user cancelled the Save As dialog. */
    export(req: ExportRequest): Promise<JobInfo | null>;
    cancel(jobId: string): Promise<void>;
    retry(jobId: string): Promise<JobInfo>;
    dismiss(jobId: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: SettingsPatch): Promise<Settings>;
    /** Resolves the new settings, or null if the dialog was cancelled. */
    chooseOutputDir(): Promise<Settings | null>;
    cleanupTemp(): Promise<CleanupResult>;
    diagnostics(): Promise<Diagnostics>;
    openOutputDir(): Promise<void>;
  };
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayloads[E]) => void): () => void;
}
