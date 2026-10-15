import { create } from 'zustand';
import type { RecordingMode, TrackKind } from '@shared/recording-types';
import { bloom, errorMessage } from '@/services/bloom';
import { acquireScreen, stopStream } from '@/services/media-devices';
import { RecorderController, RecorderStateError, type CaptureStreams, type RecorderConfig } from '@/services/recorder-controller';
import { useAppStore } from './app-store';
import { toast } from './toast-store';

export type RecorderUiPhase = 'setup' | 'acquiring' | 'countdown' | 'recording' | 'paused' | 'stopping';

export interface BeginOptions extends RecorderConfig {
  systemAudio: boolean;
  camera: MediaStream | null;
  mic: MediaStream | null;
  countdownSeconds: number;
}

interface RecorderState {
  phase: RecorderUiPhase;
  countdown: number;
  elapsedMs: number;
  screenStream: MediaStream | null;
  warnings: string[];
  error: string | null;
  mode: RecordingMode | null;
  begin(opts: BeginOptions): Promise<void>;
  cancelCountdown(): void;
  togglePause(): Promise<void>;
  stop(): Promise<void>;
  discard(): Promise<void>;
  clearError(): void;
}

let controller: RecorderController | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let pendingStart: { opts: BeginOptions; streams: CaptureStreams; screenAudio: MediaStream | null } | null = null;
let busy = false;

function createController(onSourceEnded: (kind: TrackKind) => void, onError: (msg: string) => void): RecorderController {
  return new RecorderController(
    {
      api: bloom,
      createRecorder: (stream, options) => new MediaRecorder(stream, options),
      isTypeSupported: (m) => MediaRecorder.isTypeSupported(m),
      now: () => performance.now(),
    },
    (e) => {
      if (e.type === 'source-ended') onSourceEnded(e.kind);
      if (e.type === 'error') onError(e.message);
    },
  );
}

export const useRecorderStore = create<RecorderState>((set, get) => {
  const releaseScreen = () => {
    stopStream(get().screenStream);
    stopStream(pendingStart?.screenAudio);
  };

  const finish = () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
    releaseScreen();
    pendingStart = null;
    controller = null;
    useAppStore.getState().setNavigationLocked(false);
    set({ phase: 'setup', elapsedMs: 0, screenStream: null, countdown: 0, mode: null });
  };

  const startRecorders = async () => {
    const p = pendingStart;
    if (!p) return;
    controller = createController(
      (kind) => {
        if (kind === 'screen') {
          toast.info('The shared screen or window was closed. Stopping the recording.');
          void get().stop();
        } else if (kind === 'camera' || kind === 'mic') {
          set((s) => ({ warnings: [...s.warnings, `${kind === 'camera' ? 'Camera' : 'Microphone'} disconnected — recording continues without it.`] }));
        }
      },
      (message) => {
        set({ error: `${message} What was recorded so far was saved and can be recovered from the dashboard.` });
        finish();
      },
    );
    try {
      await controller.start(p.opts, p.streams);
      set({ phase: 'recording', elapsedMs: 0 });
      ticker = setInterval(() => set({ elapsedMs: controller?.elapsedMs() ?? 0 }), 200);
    } catch (err) {
      set({ error: `Could not start recording: ${errorMessage(err)}` });
      finish();
    }
  };

  return {
    phase: 'setup',
    countdown: 0,
    elapsedMs: 0,
    screenStream: null,
    warnings: [],
    error: null,
    mode: null,

    async begin(opts) {
      if (busy || get().phase !== 'setup') return; // guards double-clicks and duplicate starts
      busy = true;
      set({ phase: 'acquiring', error: null, warnings: [], mode: opts.mode });
      useAppStore.getState().setNavigationLocked(true);
      try {
        const streams: CaptureStreams = {};
        let screenAudio: MediaStream | null = null;
        if (opts.mode !== 'camera') {
          if (!opts.sourceId) throw new Error('Choose a screen or window to record.');
          const screen = await acquireScreen({
            sourceId: opts.sourceId,
            systemAudio: opts.systemAudio,
            resolution: opts.resolution,
            frameRate: opts.frameRate,
          });
          streams.screen = screen.video;
          if (screen.audio) streams.system = screen.audio;
          screenAudio = screen.audio;
          set({ screenStream: screen.video });
          if (opts.systemAudio && !screen.audio) {
            set((s) => ({ warnings: [...s.warnings, 'System audio is not available for this source; recording without it.'] }));
          }
        }
        if (opts.mode !== 'screen' && opts.camera) streams.camera = opts.camera;
        if (opts.mic) streams.mic = opts.mic;
        pendingStart = { opts, streams, screenAudio };

        if (opts.countdownSeconds > 0) {
          set({ phase: 'countdown', countdown: opts.countdownSeconds });
          await new Promise<void>((resolve) => {
            countdownTimer = setInterval(() => {
              const next = get().countdown - 1;
              if (next <= 0 || !pendingStart) {
                if (countdownTimer) clearInterval(countdownTimer);
                countdownTimer = null;
                resolve();
              } else set({ countdown: next });
            }, 1000);
          });
          if (!pendingStart) return; // cancelled during countdown
        }
        await startRecorders();
      } catch (err) {
        set({ error: errorMessage(err) });
        finish();
      } finally {
        busy = false;
      }
    },

    cancelCountdown() {
      if (get().phase !== 'countdown') return;
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = null;
      finish();
    },

    async togglePause() {
      if (!controller || busy) return;
      busy = true;
      try {
        if (controller.currentPhase === 'recording') {
          await controller.pause();
          set({ phase: 'paused', elapsedMs: controller.elapsedMs() });
        } else if (controller.currentPhase === 'paused') {
          await controller.resume();
          set({ phase: 'recording' });
        }
      } catch (err) {
        if (!(err instanceof RecorderStateError)) toast.error(errorMessage(err));
      } finally {
        busy = false;
      }
    },

    async stop() {
      const c = controller;
      if (!c || (c.currentPhase !== 'recording' && c.currentPhase !== 'paused')) return;
      set({ phase: 'stopping' });
      try {
        const { recordingId } = await c.stop();
        finish();
        useAppStore.getState().navigate({ name: 'player', id: recordingId });
      } catch (err) {
        set({ error: `${errorMessage(err)} Your recording can be recovered from the dashboard.` });
        finish();
      }
    },

    async discard() {
      const c = controller;
      if (!c) return;
      set({ phase: 'stopping' });
      await c.cancel(true);
      finish();
      toast.info('Recording discarded.');
    },

    clearError() {
      set({ error: null });
    },
  };
});
