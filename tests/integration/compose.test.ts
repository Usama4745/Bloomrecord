import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MediaService } from '../../electron/media/media-service';
import { bins, firstBrightFrameSec, firstLoudSampleSec, frameRgb, hasFfmpeg, makeAudioWebm, makeVideoWebm, peakLevel, tmpDir } from '../helpers/media';

const describeMedia = hasFfmpeg ? describe : describe.skip;

describeMedia('media compositing (real FFmpeg)', () => {
  const media = new MediaService(bins);
  let dir: string;
  let screen: string;
  let camera: string;
  let mic: string;
  let system: string;

  beforeAll(() => {
    dir = tmpDir();
    // Blue screen with a white flash at t=1.0s..1.2s.
    screen = makeVideoWebm(
      path.join(dir, 'screen.webm'),
      "color=c=blue:s=1280x720:r=30:d=3,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,1,1.2)'",
    );
    // 4:3 red camera — must be center-cropped, not squashed, into the circle.
    camera = makeVideoWebm(path.join(dir, 'camera.webm'), 'color=c=red:s=640x480:r=30:d=3');
    // Mic: silent for 0.5s, then a loud tone. Recorded with a 500ms later start → tone lands at 1.0s.
    mic = makeAudioWebm(path.join(dir, 'mic.webm'), "aevalsrc='if(gte(t,0.5),0.9*sin(2*PI*1000*t),0)':s=48000:d=2.5");
    // Loud system audio to stress the mixer/limiter.
    system = makeAudioWebm(path.join(dir, 'system.webm'), "aevalsrc='0.9*sin(2*PI*440*t)':s=48000:d=3");
  });

  it('composites screen + circular camera bubble + mixed audio into a verified MP4', async () => {
    const out = path.join(dir, 'out.mp4');
    const progress: Array<number | null> = [];
    const { plan, probe } = await media.compose(
      [
        { kind: 'screen', path: screen, offsetMs: 0 },
        { kind: 'camera', path: camera, offsetMs: 20 },
        { kind: 'mic', path: mic, offsetMs: 500 },
        { kind: 'system', path: system, offsetMs: 0 },
      ],
      {
        mode: 'screen-camera',
        bubblePosition: 'bottom-right',
        bubbleSize: 'medium',
        quality: 'medium',
        frameRate: 30,
        resolution: '1080p',
        outputPath: out,
        workDir: dir,
      },
      (p) => progress.push(p),
    );

    expect(plan.warnings).toEqual([]);
    expect(probe.video?.codec).toBe('h264');
    expect(probe.audio?.codec).toBe('aac');
    expect(probe.video?.width).toBe(1280);
    expect(probe.video?.height).toBe(720);
    expect(probe.durationMs).toBeGreaterThan(2800);
    expect(probe.durationMs).toBeLessThan(3300);
    expect(progress.at(-1)).toBe(1);

    // Bubble geometry: centre is camera red; the corner of its bounding square is screen blue (masked out).
    const b = plan.bubble!;
    const px = frameRgb(out, 2.0, 1280, 720);
    const [cr, cg, cb] = px(b.x + b.diameter / 2, b.y + b.diameter / 2);
    expect(cr).toBeGreaterThan(180);
    expect(cg).toBeLessThan(80);
    expect(cb).toBeLessThan(80);
    const [kr, , kb] = px(b.x + 3, b.y + 3);
    expect(kb).toBeGreaterThan(180);
    expect(kr).toBeLessThan(80);
    // Edge midpoint just inside the circle is red: aspect ratio preserved, circle touches its box.
    const [er] = px(b.x + b.diameter / 2, b.y + 4);
    expect(er).toBeGreaterThan(150);

    // No clipping from summing two loud sources.
    expect(peakLevel(out)).toBeLessThan(0.99);
  });

  it('keeps audio aligned with video using recorder start offsets', async () => {
    const out = path.join(dir, 'sync.mp4');
    await media.compose(
      [
        { kind: 'screen', path: screen, offsetMs: 0 },
        { kind: 'mic', path: mic, offsetMs: 500 },
      ],
      {
        mode: 'screen',
        bubblePosition: 'bottom-left',
        bubbleSize: 'small',
        quality: 'low',
        frameRate: 30,
        resolution: '720p',
        outputPath: out,
        workDir: dir,
      },
      () => {},
    );
    const flash = firstBrightFrameSec(out, 30)!;
    const beep = firstLoudSampleSec(out)!;
    expect(flash).toBeCloseTo(1.0, 1);
    expect(Math.abs(beep - flash)).toBeLessThan(0.05);
  });

  it('aligns tracks that started before the screen recorder', async () => {
    const out = path.join(dir, 'early.mp4');
    // Screen recorder started 300ms after the mic: the first 300ms of mic audio precede the video and are trimmed.
    await media.compose(
      [
        { kind: 'screen', path: screen, offsetMs: 300 },
        { kind: 'mic', path: mic, offsetMs: 0 },
      ],
      {
        mode: 'screen',
        bubblePosition: 'bottom-left',
        bubbleSize: 'small',
        quality: 'low',
        frameRate: 30,
        resolution: '720p',
        outputPath: out,
        workDir: dir,
      },
      () => {},
    );
    // Tone at 0.5s in mic time = 0.2s in screen time.
    expect(firstLoudSampleSec(out)!).toBeCloseTo(0.2, 1);
  });

  it('produces camera-only recordings at the camera aspect ratio', async () => {
    const out = path.join(dir, 'cam.mp4');
    const { probe } = await media.compose(
      [
        { kind: 'camera', path: camera, offsetMs: 0 },
        { kind: 'mic', path: mic, offsetMs: 0 },
      ],
      {
        mode: 'camera',
        bubblePosition: 'bottom-left',
        bubbleSize: 'small',
        quality: 'low',
        frameRate: 30,
        resolution: '1080p',
        outputPath: out,
        workDir: dir,
      },
      () => {},
    );
    expect(probe.video).toMatchObject({ codec: 'h264', width: 640, height: 480 });
    expect(probe.audio?.codec).toBe('aac');
  });

  it('falls back to no bubble when the camera file is empty', async () => {
    const empty = path.join(dir, 'empty-cam.webm');
    fs.writeFileSync(empty, '');
    const out = path.join(dir, 'nocam.mp4');
    const { plan, probe } = await media.compose(
      [
        { kind: 'screen', path: screen, offsetMs: 0 },
        { kind: 'camera', path: empty, offsetMs: 0 },
      ],
      {
        mode: 'screen-camera',
        bubblePosition: 'top-left',
        bubbleSize: 'large',
        quality: 'low',
        frameRate: 15,
        resolution: '720p',
        outputPath: out,
        workDir: dir,
      },
      () => {},
    );
    expect(plan.bubble).toBeNull();
    expect(plan.warnings.join(' ')).toMatch(/Camera/);
    expect(probe.audio).toBeNull();
  });

  it('recovers a truncated (interrupted) WebM recording', async () => {
    const full = fs.readFileSync(screen);
    const truncated = path.join(dir, 'truncated.webm');
    fs.writeFileSync(truncated, full.subarray(0, Math.floor(full.length * 0.6)));
    const out = path.join(dir, 'recovered.mp4');
    const { probe } = await media.compose(
      [{ kind: 'screen', path: truncated, offsetMs: 0 }],
      {
        mode: 'screen',
        bubblePosition: 'top-left',
        bubbleSize: 'small',
        quality: 'low',
        frameRate: 30,
        resolution: '720p',
        outputPath: out,
        workDir: dir,
      },
      () => {},
    );
    expect(probe.video?.codec).toBe('h264');
    expect(probe.durationMs).toBeGreaterThan(500);
  });

  it('fails with a clear error when the screen track is unusable', async () => {
    const garbage = path.join(dir, 'garbage.webm');
    fs.writeFileSync(garbage, Buffer.from('not a webm file at all'));
    await expect(
      media.compose(
        [{ kind: 'screen', path: garbage, offsetMs: 0 }],
        {
          mode: 'screen',
          bubblePosition: 'top-left',
          bubbleSize: 'small',
          quality: 'low',
          frameRate: 30,
          resolution: '720p',
          outputPath: path.join(dir, 'never.mp4'),
          workDir: dir,
        },
        () => {},
      ),
    ).rejects.toThrow(/screen recording is missing/i);
  });
});
