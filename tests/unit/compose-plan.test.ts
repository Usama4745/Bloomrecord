import { describe, expect, it } from 'vitest';
import { bubbleLayout, outputSize, planCompose, type ComposeInput, type ComposeOptions } from '../../electron/media/compose';
import type { MediaProbe } from '../../electron/media/probe';

const video = (w: number, h: number): MediaProbe => ({
  formatName: 'webm',
  durationMs: null,
  sizeBytes: 1,
  video: { codec: 'vp9', width: w, height: h, fps: null },
  audio: null,
});
const audio: MediaProbe = { formatName: 'webm', durationMs: null, sizeBytes: 1, video: null, audio: { codec: 'opus', sampleRate: 48000, channels: 1 } };
const empty: MediaProbe = { formatName: 'unknown', durationMs: null, sizeBytes: null, video: null, audio: null };

const opts: ComposeOptions = {
  mode: 'screen-camera',
  bubblePosition: 'bottom-left',
  bubbleSize: 'medium',
  quality: 'high',
  frameRate: 30,
  resolution: '1080p',
  outputPath: '/out/final.partial.mp4',
  maskPathFor: (d) => `/tmp/mask-${d}.pgm`,
};

const input = (kind: ComposeInput['kind'], probe: MediaProbe, offsetMs = 0, durationMs: number | null = 10_000): ComposeInput => ({
  kind,
  path: `/tmp/${kind}.webm`,
  offsetMs,
  probe,
  durationMs,
});

describe('compose planning', () => {
  it('fits output into the preset without upscaling and keeps dimensions even', () => {
    expect(outputSize(2560, 1440, '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(1280, 720, '1080p')).toEqual({ width: 1280, height: 720 });
    expect(outputSize(3440, 1440, '1440p')).toEqual({ width: 2560, height: 1072 });
    expect(outputSize(1001, 777, 'native')).toEqual({ width: 1002, height: 778 });
    expect(outputSize(1080, 1920, '1080p')).toEqual({ width: 608, height: 1080 }); // portrait
  });

  it('places the bubble in each corner with a margin', () => {
    const bl = bubbleLayout(1920, 1080, 'medium', 'bottom-left');
    expect(bl.diameter).toBe(270);
    expect(bl.x).toBe(38);
    expect(bl.y).toBe(1080 - 270 - 38);
    const tr = bubbleLayout(1920, 1080, 'small', 'top-right');
    expect(tr.x + tr.diameter).toBe(1920 - 38);
    expect(tr.y).toBe(38);
    expect(bubbleLayout(200, 100, 'small', 'top-left').diameter).toBe(64); // floor
  });

  it('builds a full screen + camera + mic + system plan', () => {
    const plan = planCompose(
      [input('screen', video(2560, 1440), 0), input('camera', video(1280, 720), 40), input('mic', audio, 15), input('system', audio, 0)],
      opts,
    );
    expect(plan.width).toBe(1920);
    expect(plan.bubble).not.toBeNull();
    expect(plan.audioSources).toEqual(['mic', 'system']);
    const fc = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    expect(fc).toContain('alphamerge');
    expect(fc).toContain("crop='min(iw,ih)':'min(iw,ih)'");
    expect(fc).toContain('amix=inputs=2');
    expect(fc).toContain('normalize=0');
    expect(fc).toContain('alimiter');
    expect(fc).toContain('setpts=PTS-STARTPTS+0.040/TB'); // camera started 40ms after the screen
    expect(fc).toContain('adelay=15:all=1');
    expect(plan.args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', '-t', '10.000']));
    expect(plan.args.at(-1)).toBe('/out/final.partial.mp4');
    // Mask input is the last -i.
    const lastInput = plan.args.lastIndexOf('-i');
    expect(plan.args[lastInput + 1]).toBe(`/tmp/mask-${plan.bubble!.diameter}.pgm`);
  });

  it('trims tracks that started before the base video', () => {
    const plan = planCompose([input('screen', video(1280, 720), 250), input('mic', audio, 0)], { ...opts, mode: 'screen' });
    const fc = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    expect(fc).toContain('atrim=start=0.250');
    expect(plan.bubble).toBeNull();
  });

  it('handles video-only recordings', () => {
    const plan = planCompose([input('screen', video(1280, 720))], { ...opts, mode: 'screen' });
    expect(plan.args).toContain('-an');
    expect(plan.args).not.toContain('-c:a');
  });

  it('degrades gracefully when optional tracks are unusable', () => {
    const plan = planCompose([input('screen', video(1280, 720)), input('camera', empty), input('mic', empty)], opts);
    expect(plan.bubble).toBeNull();
    expect(plan.warnings).toHaveLength(2);
  });

  it('fails clearly when the base track is unusable', () => {
    expect(() => planCompose([input('screen', empty)], { ...opts, mode: 'screen' })).toThrow(/screen recording is missing/);
    expect(() => planCompose([input('screen', video(10, 10))], { ...opts, mode: 'camera' })).toThrow(/camera recording is missing/);
  });

  it('falls back to -shortest when no duration is known', () => {
    const plan = planCompose([input('screen', video(1280, 720), 0, null), input('mic', audio, 0, null)], { ...opts, mode: 'screen' });
    expect(plan.args).toContain('-shortest');
    expect(plan.args).not.toContain('-t');
  });
});
