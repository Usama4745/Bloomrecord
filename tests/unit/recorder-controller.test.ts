import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecorderController, RecorderStateError, type RecorderConfig, type RecorderDeps } from '@/services/recorder-controller';
import { pickMimeType } from '@/services/media-support';

/** Minimal MediaRecorder stand-in driven by the test. */
class FakeRecorder {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  timeslice = 0;
  constructor(
    readonly stream: FakeStream,
    readonly options: MediaRecorderOptions,
  ) {}
  start(timeslice: number) {
    this.timeslice = timeslice;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => {
      this.emit(`final-${this.stream.kind}`);
      this.onstop?.();
    });
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
}

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  constructor(readonly kind: string) {}
  getTracks() {
    return [this.track];
  }
}

const config: RecorderConfig = {
  mode: 'screen-camera',
  sourceId: 'screen:1:0',
  sourceName: 'Screen',
  resolution: '1080p',
  frameRate: 30,
  quality: 'high',
  bubblePosition: 'bottom-left',
  bubbleSize: 'medium',
};

function setup(overrides: Partial<RecorderDeps['api']['recording']> = {}) {
  const recorders: FakeRecorder[] = [];
  const written: Array<{ kind: string; text: string }> = [];
  let now = 1000;
  const recording = {
    start: vi.fn(async () => ({ sessionId: 'sess-1', createdAt: 0 })),
    writeChunk: vi.fn(async (_id: string, kind: string, data: Uint8Array) => {
      written.push({ kind, text: new TextDecoder().decode(data) });
    }),
    trackStarted: vi.fn(async () => {}),
    pause: vi.fn(async () => ({}) as never),
    resume: vi.fn(async () => ({}) as never),
    stop: vi.fn(async () => ({ recordingId: 'rec-1', jobId: 'job-1' })),
    abort: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    listInterrupted: vi.fn(),
    recover: vi.fn(),
    ...overrides,
  };
  const events: unknown[] = [];
  const controller = new RecorderController(
    {
      api: { recording } as unknown as RecorderDeps['api'],
      createRecorder: (stream, options) => {
        const r = new FakeRecorder(stream as unknown as FakeStream, options);
        recorders.push(r);
        return r as unknown as MediaRecorder;
      },
      isTypeSupported: (m) => m.startsWith('video/webm;codecs=vp8') || m === 'audio/webm;codecs=opus',
      now: () => now,
    },
    (e) => events.push(e),
  );
  const streams = {
    screen: new FakeStream('screen') as unknown as MediaStream,
    camera: new FakeStream('camera') as unknown as MediaStream,
    mic: new FakeStream('mic') as unknown as MediaStream,
  };
  return { controller, recorders, written, recording, streams, events, advance: (ms: number) => (now += ms) };
}

describe('MIME selection', () => {
  it('prefers VP8/Opus WebM and falls back', () => {
    expect(pickMimeType('screen', () => true)).toBe('video/webm;codecs=vp8');
    expect(pickMimeType('camera', (m) => m === 'video/mp4')).toBe('video/mp4');
    expect(pickMimeType('mic', (m) => m.startsWith('audio/mp4'))).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(pickMimeType('mic', () => false)).toBeNull();
  });
});

describe('recorder controller', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('starts one recorder per track with detected MIME types and reports offsets', async () => {
    await t.controller.start(config, t.streams);
    expect(t.recording.start).toHaveBeenCalledWith(
      expect.objectContaining({
        tracks: [
          { kind: 'screen', mimeType: 'video/webm;codecs=vp8' },
          { kind: 'camera', mimeType: 'video/webm;codecs=vp8' },
          { kind: 'mic', mimeType: 'audio/webm;codecs=opus' },
        ],
      }),
    );
    expect(t.recorders).toHaveLength(3);
    expect(t.recorders.every((r) => r.state === 'recording' && r.timeslice === 1000)).toBe(true);
    expect(t.recorders[0]!.options.videoBitsPerSecond).toBeGreaterThan(1_000_000);
    expect(t.recording.trackStarted).toHaveBeenCalledTimes(3);
    expect(t.controller.currentPhase).toBe('recording');
  });

  it('rejects duplicate starts and conflicting operations', async () => {
    const first = t.controller.start(config, t.streams);
    await expect(t.controller.start(config, t.streams)).rejects.toBeInstanceOf(RecorderStateError);
    await first;
    await expect(t.controller.resume()).rejects.toBeInstanceOf(RecorderStateError);
    await t.controller.pause();
    await expect(t.controller.pause()).rejects.toBeInstanceOf(RecorderStateError);
    expect(t.recording.start).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes all recorders together and excludes paused time', async () => {
    await t.controller.start(config, t.streams);
    t.advance(3000);
    await t.controller.pause();
    expect(t.recorders.every((r) => r.state === 'paused')).toBe(true);
    t.advance(10_000);
    expect(t.controller.elapsedMs()).toBe(3000);
    await t.controller.resume();
    expect(t.recorders.every((r) => r.state === 'recording')).toBe(true);
    t.advance(2000);
    expect(t.controller.elapsedMs()).toBe(5000);
  });

  it('does not touch recorders if main rejects a pause', async () => {
    t = setup({ pause: vi.fn(async () => Promise.reject(new Error('[bloom:CONFLICT] nope'))) });
    await t.controller.start(config, t.streams);
    await expect(t.controller.pause()).rejects.toThrow(/nope/);
    expect(t.recorders.every((r) => r.state === 'recording')).toBe(true);
    expect(t.controller.currentPhase).toBe('recording');
  });

  it('writes chunks in order and flushes everything before stopping', async () => {
    await t.controller.start(config, t.streams);
    t.recorders[0]!.emit('s1');
    t.recorders[2]!.emit('m1');
    t.recorders[0]!.emit('s2');
    const result = await t.controller.stop('My title');
    expect(result).toEqual({ recordingId: 'rec-1', jobId: 'job-1' });
    const screen = t.written.filter((w) => w.kind === 'screen').map((w) => w.text);
    expect(screen).toEqual(['s1', 's2', 'final-screen']);
    expect(t.written.filter((w) => w.kind === 'camera').map((w) => w.text)).toEqual(['final-camera']);
    // stop() reaches main only after every final chunk was written.
    const stopOrder = vi.mocked(t.recording.stop).mock.invocationCallOrder[0]!;
    expect(Math.max(...vi.mocked(t.recording.writeChunk).mock.invocationCallOrder)).toBeLessThan(stopOrder);
    expect(t.recording.stop).toHaveBeenCalledWith('sess-1', 'My title');
    expect(t.controller.currentPhase).toBe('stopped');
    await expect(t.controller.stop()).rejects.toBeInstanceOf(RecorderStateError);
  });

  it('stops and reports when writing to disk fails', async () => {
    t = setup({ writeChunk: vi.fn(async () => Promise.reject(new Error('[bloom:DISK_FULL] Disk is full'))) });
    await t.controller.start(config, t.streams);
    t.recorders[0]!.emit('x');
    await vi.waitFor(() => expect(t.controller.currentPhase).toBe('failed'));
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringMatching(/Disk is full/) }));
    expect(t.recorders.every((r) => r.state === 'inactive')).toBe(true);
    // Main already aborted the session on write failure; no second abort.
    expect(t.recording.abort).not.toHaveBeenCalled();
  });

  it('surfaces source termination (shared window closed / device unplugged)', async () => {
    await t.controller.start(config, t.streams);
    (t.streams.camera as unknown as FakeStream).track.end();
    expect(t.events).toContainEqual({ type: 'source-ended', kind: 'camera' });
  });

  it('cleans up the session if starting fails', async () => {
    t = setup({ trackStarted: vi.fn(async () => {}) });
    const failing = setup();
    // No supported audio MIME type → start fails before any recorder runs.
    const c = new RecorderController({
      api: { recording: failing.recording } as unknown as RecorderDeps['api'],
      createRecorder: () => {
        throw new Error('should not be called');
      },
      isTypeSupported: (m) => m.startsWith('video/'),
      now: () => 0,
    });
    await expect(c.start(config, failing.streams)).rejects.toThrow(/cannot record audio/);
    expect(failing.recording.start).not.toHaveBeenCalled();
    expect(c.currentPhase).toBe('idle');
  });

  it('cancel(discard) aborts and discards the session', async () => {
    await t.controller.start(config, t.streams);
    await t.controller.cancel(true);
    expect(t.recording.abort).toHaveBeenCalledWith('sess-1', expect.any(String));
    expect(t.recording.discard).toHaveBeenCalledWith('sess-1');
    expect(t.controller.currentPhase).toBe('idle');
  });
});
