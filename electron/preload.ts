import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels as C, IpcEvents, encodeIpcError, type BloomApi, type IpcChannel, type IpcResult } from '@shared/ipc-contracts';

// The preload runs sandboxed: it only forwards calls on fixed channels and
// unwraps the result envelope. All validation happens in the main process.

async function call<T>(channel: IpcChannel, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  if (result && typeof result === 'object' && 'ok' in result) {
    if (result.ok) return result.data;
    // contextBridge only preserves an Error's message, so the code travels inside it.
    throw new Error(encodeIpcError(result.error.code, result.error.message));
  }
  throw new Error(encodeIpcError('INTERNAL', 'Malformed IPC response'));
}

const allowedEvents = new Set<string>(Object.values(IpcEvents));

const api: BloomApi = {
  capture: {
    listSources: (types) => call(C.captureListSources, { types }),
    prepareSource: (sourceId, systemAudio) => call(C.capturePrepareSource, { sourceId, systemAudio }),
    platform: () => call(C.capturePlatform),
    permissionStatus: (kind) => call(C.capturePermissionStatus, kind),
    requestPermission: (kind) => call(C.captureRequestPermission, kind),
    openPermissionSettings: (kind) => call(C.captureOpenPermissionSettings, kind),
  },
  recording: {
    start: (req) => call(C.recordingStart, req),
    writeChunk: (sessionId, kind, data) => call(C.recordingWriteChunk, { sessionId, kind, data }),
    trackStarted: (sessionId, kind, offsetMs) => call(C.recordingTrackStarted, { sessionId, kind, offsetMs }),
    pause: (sessionId) => call(C.recordingPause, { sessionId }),
    resume: (sessionId) => call(C.recordingResume, { sessionId }),
    stop: (sessionId, title) => call(C.recordingStop, title === undefined ? { sessionId } : { sessionId, title }),
    abort: (sessionId, reason) => call(C.recordingAbort, { sessionId, reason }),
    listInterrupted: () => call(C.recordingListInterrupted),
    recover: (sessionId) => call(C.recordingRecover, { sessionId }),
    discard: (sessionId) => call(C.recordingDiscard, { sessionId }),
  },
  library: {
    list: (req) => call(C.libraryList, req),
    get: (id) => call(C.libraryGet, { id }),
    rename: (id, title) => call(C.libraryRename, { id, title }),
    delete: (id, deleteFile) => call(C.libraryDelete, { id, deleteFile }),
    reveal: (id) => call(C.libraryReveal, { id }),
    stats: () => call(C.libraryStats),
  },
  jobs: {
    list: () => call(C.jobsList),
    export: (req) => call(C.jobsExport, req),
    cancel: (jobId) => call(C.jobsCancel, { jobId }),
    retry: (jobId) => call(C.jobsRetry, { jobId }),
    dismiss: (jobId) => call(C.jobsDismiss, { jobId }),
  },
  settings: {
    get: () => call(C.settingsGet),
    update: (patch) => call(C.settingsUpdate, patch),
    chooseOutputDir: () => call(C.settingsChooseOutputDir),
    cleanupTemp: () => call(C.settingsCleanupTemp),
    diagnostics: () => call(C.settingsDiagnostics),
    openOutputDir: () => call(C.settingsOpenOutputDir),
    chooseBackgroundImage: () => call(C.settingsChooseBackgroundImage),
    getBackgroundImage: () => call(C.settingsGetBackgroundImage),
  },
  on(event, listener) {
    if (!allowedEvents.has(event)) throw new Error(`Unknown event: ${String(event)}`);
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(event, wrapped);
    return () => {
      ipcRenderer.removeListener(event, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('bloom', api);
