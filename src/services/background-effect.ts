import { ImageSegmenter } from '@mediapipe/tasks-vision';
import type { BackgroundBlur, BackgroundEffect, BackgroundPreset } from '@shared/recording-types';
import { coverRect, drawPreset, processingSize } from './background-presets';

/*
 * Webcam background blur / replacement, computed locally:
 *   camera track → MediaStreamTrackProcessor (VideoFrames)
 *     → MediaPipe selfie segmentation (bundled model, GPU with CPU fallback)
 *     → 2D canvas compositing (blurred or replacement background + masked person)
 *   → MediaStreamTrackGenerator → new camera track
 * The generated track is used for both preview and recording, so the rest of
 * the pipeline is unchanged. Frames are pulled from the camera rather than
 * driven by requestAnimationFrame, so processing continues while the window is
 * minimized or hidden.
 */

export interface BackgroundOptions {
  effect: Exclude<BackgroundEffect, 'none'>;
  blur: BackgroundBlur;
  preset: BackgroundPreset;
  /** Decoded custom image, used when preset is 'custom'. */
  customImage: ImageBitmap | null;
}

// Chromium "breakout box" APIs (not yet in TypeScript's DOM lib).
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' });
  readonly writable: WritableStream<VideoFrame>;
}

export function backgroundEffectsSupported(): boolean {
  return typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function' &&
    typeof (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator === 'function' &&
    typeof OffscreenCanvas === 'function';
}

let segmenterPromise: Promise<ImageSegmenter> | null = null;

/** Loads the bundled segmentation model once per app session. */
export function loadSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    const base = new URL('./', document.baseURI).href;
    const fileset = {
      wasmLoaderPath: `${base}mediapipe/vision_wasm_internal.js`,
      wasmBinaryPath: `${base}mediapipe/vision_wasm_internal.wasm`,
    };
    const create = (delegate: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/selfie_segmenter_landscape.tflite`, delegate },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    segmenterPromise = create('GPU')
      .catch(() => create('CPU'))
      .catch((err: unknown) => {
        segmenterPromise = null; // allow a later retry
        throw err;
      });
  }
  return segmenterPromise;
}

type Ctx2D = OffscreenCanvasRenderingContext2D;

function ctx2d(c: OffscreenCanvas): Ctx2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return ctx;
}

export class BackgroundProcessor {
  readonly stream: MediaStream;
  private options: BackgroundOptions;
  private stopped = false;
  private readonly generator: MediaStreamTrackGenerator;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private lastTimestamp = 0;
  private framesProcessed = 0;

  private constructor(
    private readonly segmenter: ImageSegmenter,
    private readonly source: MediaStreamTrack,
    options: BackgroundOptions,
    private readonly onError: (err: unknown) => void,
  ) {
    this.options = options;
    this.generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.stream = new MediaStream([this.generator]);
  }

  /** Starts processing `input`'s video track. Rejects if effects are unsupported or the model cannot load. */
  static async create(input: MediaStream, options: BackgroundOptions, onError: (err: unknown) => void = () => {}): Promise<BackgroundProcessor> {
    if (!backgroundEffectsSupported()) throw new Error('Background effects are not supported on this system.');
    const track = input.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') throw new Error('No camera video to process.');
    const segmenter = await loadSegmenter();
    const p = new BackgroundProcessor(segmenter, track, options, onError);
    void p.run();
    return p;
  }

  get processedFrames(): number {
    return this.framesProcessed;
  }

  setOptions(options: BackgroundOptions): void {
    this.options = options;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.reader?.cancel().catch(() => {});
    this.generator.stop();
  }

  private async run(): Promise<void> {
    const processor = new MediaStreamTrackProcessor({ track: this.source });
    this.reader = processor.readable.getReader();
    const writer = this.generator.writable.getWriter();

    const settings = this.source.getSettings();
    const { width, height } = processingSize(settings.width ?? 0, settings.height ?? 0);
    const out = new OffscreenCanvas(width, height);
    const person = new OffscreenCanvas(width, height);
    const small = new OffscreenCanvas(Math.max(2, Math.round(width / 6)), Math.max(2, Math.round(height / 6)));
    const mask = new OffscreenCanvas(2, 2);
    const backdrop = new OffscreenCanvas(width, height);
    const octx = ctx2d(out);
    const pctx = ctx2d(person);
    const sctx = ctx2d(small);
    const mctx = ctx2d(mask);
    const bctx = ctx2d(backdrop);
    let maskImage: ImageData | null = null;
    let backdropKey = '';

    try {
      while (!this.stopped) {
        const { value: frame, done } = await this.reader.read();
        if (done || !frame) break;
        try {
          // MediaPipe requires strictly increasing timestamps (ms).
          const ts = Math.max(this.lastTimestamp + 1, frame.timestamp / 1000);
          this.lastTimestamp = ts;
          const result = this.segmenter.segmentForVideo(frame, ts);
          const confidence = result.confidenceMasks?.[0];
          if (confidence) {
            const mw = confidence.width;
            const mh = confidence.height;
            if (mask.width !== mw || mask.height !== mh || !maskImage) {
              mask.width = mw;
              mask.height = mh;
              maskImage = new ImageData(mw, mh);
            }
            const data = confidence.getAsFloat32Array();
            const px = maskImage.data;
            for (let i = 0; i < data.length; i++) {
              px[i * 4 + 3] = Math.min(255, Math.max(0, Math.round(data[i]! * 255)));
            }
            mctx.putImageData(maskImage, 0, 0);
          }
          result.close();

          const o = this.options;
          // Background layer.
          octx.globalCompositeOperation = 'copy';
          if (o.effect === 'blur') {
            // Downscale → blur → upscale is far cheaper than a full-size blur.
            const strength = o.blur === 'strong' ? 6 : 3;
            sctx.filter = `blur(${strength}px)`;
            sctx.drawImage(frame, -strength * 2, -strength * 2, small.width + strength * 4, small.height + strength * 4);
            sctx.filter = 'none';
            octx.imageSmoothingQuality = 'high';
            octx.drawImage(small, 0, 0, width, height);
          } else {
            const key = `${o.preset}:${o.customImage ? `${o.customImage.width}x${o.customImage.height}` : ''}:${width}x${height}`;
            if (key !== backdropKey) {
              backdropKey = key;
              if (o.preset === 'custom' && o.customImage) {
                const r = coverRect(o.customImage.width, o.customImage.height, width, height);
                bctx.fillStyle = '#000';
                bctx.fillRect(0, 0, width, height);
                bctx.drawImage(o.customImage, r.x, r.y, r.w, r.h);
              } else {
                drawPreset(bctx, o.preset === 'custom' ? 'slate' : o.preset, width, height);
              }
            }
            octx.drawImage(backdrop, 0, 0);
          }

          // Person layer: camera frame masked by the (feathered) segmentation mask.
          pctx.globalCompositeOperation = 'copy';
          pctx.drawImage(frame, 0, 0, width, height);
          pctx.globalCompositeOperation = 'destination-in';
          pctx.filter = 'blur(2px)';
          pctx.imageSmoothingQuality = 'high';
          pctx.drawImage(mask, 0, 0, width, height);
          pctx.filter = 'none';
          octx.globalCompositeOperation = 'source-over';
          octx.drawImage(person, 0, 0);

          const processed = new VideoFrame(out, { timestamp: frame.timestamp });
          await writer.write(processed);
          this.framesProcessed++;
        } finally {
          frame.close();
        }
      }
    } catch (err) {
      if (!this.stopped) this.onError(err);
    } finally {
      this.stopped = true;
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
      this.generator.stop();
    }
  }
}
