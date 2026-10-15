import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitive enums
// ---------------------------------------------------------------------------

export const recordingModeSchema = z.enum(['screen', 'screen-camera', 'camera']);
export const trackKindSchema = z.enum(['screen', 'camera', 'mic', 'system']);
export const bubblePositionSchema = z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
export const bubbleSizeSchema = z.enum(['small', 'medium', 'large']);
export const qualityPresetSchema = z.enum(['low', 'medium', 'high']);
export const resolutionPresetSchema = z.enum(['720p', '1080p', '1440p', '2160p', 'native']);
export const frameRateSchema = z.union([z.literal(15), z.literal(24), z.literal(30), z.literal(60)]);
export const themeSchema = z.enum(['system', 'light', 'dark']);
export const backgroundEffectSchema = z.enum(['none', 'blur', 'image']);
export const backgroundBlurSchema = z.enum(['light', 'strong']);
export const BACKGROUND_PRESET_IDS = ['aurora', 'sunset', 'ocean', 'forest', 'slate', 'paper'] as const;
export const backgroundPresetSchema = z.enum([...BACKGROUND_PRESET_IDS, 'custom']);

export const idSchema = z.uuid();

/** Display name typed by the user. Control characters are rejected; length is bounded. */
export const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title cannot be empty')
  .max(200, 'Title is too long')
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Title contains invalid characters');

/** MediaRecorder MIME types we know how to process. */
export const recorderMimeSchema = z
  .string()
  .max(128)
  .regex(/^(video|audio)\/(webm|mp4|x-matroska)(;[\w\s=.,"-]*)?$/i, 'Unsupported recording MIME type');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settingsSchema = z.object({
  outputDir: z.string().min(1).max(4096),
  defaultMode: recordingModeSchema,
  resolution: resolutionPresetSchema,
  frameRate: frameRateSchema,
  quality: qualityPresetSchema,
  cameraDeviceId: z.string().max(512).nullable(),
  micDeviceId: z.string().max(512).nullable(),
  systemAudio: z.boolean(),
  bubblePosition: bubblePositionSchema,
  bubbleSize: bubbleSizeSchema,
  theme: themeSchema,
  countdownSeconds: z.number().int().min(0).max(10),
  minimizeOnRecord: z.boolean(),
  backgroundEffect: backgroundEffectSchema,
  backgroundBlur: backgroundBlurSchema,
  backgroundPreset: backgroundPresetSchema,
  /** File name of the user's custom background inside <userData>/backgrounds; set only by main. */
  backgroundCustomImage: z.string().max(64).nullable(),
});

/** Settings the renderer may change directly. The output folder can only be set through the native dialog. */
export const settingsPatchSchema = settingsSchema.omit({ outputDir: true, backgroundCustomImage: true }).partial().strict();

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export const listSourcesRequestSchema = z
  .object({ types: z.array(z.enum(['screen', 'window'])).min(1).max(2) })
  .strict();

export const prepareSourceRequestSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    systemAudio: z.boolean(),
  })
  .strict();

export const mediaPermissionSchema = z.enum(['camera', 'microphone', 'screen']);

// ---------------------------------------------------------------------------
// Recording sessions
// ---------------------------------------------------------------------------

export const trackSpecSchema = z
  .object({
    kind: trackKindSchema,
    mimeType: recorderMimeSchema,
  })
  .strict();

export const startRecordingRequestSchema = z
  .object({
    mode: recordingModeSchema,
    sourceId: z.string().max(256).nullable(),
    sourceName: z.string().max(512).nullable(),
    tracks: z.array(trackSpecSchema).min(1).max(4),
    bubblePosition: bubblePositionSchema,
    bubbleSize: bubbleSizeSchema,
    quality: qualityPresetSchema,
    frameRate: frameRateSchema,
    resolution: resolutionPresetSchema,
  })
  .strict()
  .superRefine((req, ctx) => {
    const kinds = req.tracks.map((t) => t.kind);
    if (new Set(kinds).size !== kinds.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate track kinds', path: ['tracks'] });
    }
    const has = (k: string) => kinds.includes(k as never);
    if (req.mode === 'camera') {
      if (!has('camera')) ctx.addIssue({ code: 'custom', message: 'Camera mode requires a camera track', path: ['tracks'] });
      if (has('screen') || has('system')) ctx.addIssue({ code: 'custom', message: 'Camera mode cannot include screen tracks', path: ['tracks'] });
    } else {
      if (!has('screen')) ctx.addIssue({ code: 'custom', message: 'Screen modes require a screen track', path: ['tracks'] });
      if (!req.sourceId) ctx.addIssue({ code: 'custom', message: 'A capture source is required', path: ['sourceId'] });
      if (req.mode === 'screen-camera' && !has('camera')) ctx.addIssue({ code: 'custom', message: 'Screen + camera mode requires a camera track', path: ['tracks'] });
      if (req.mode === 'screen' && has('camera')) ctx.addIssue({ code: 'custom', message: 'Screen-only mode cannot include a camera track', path: ['tracks'] });
    }
  });

/** Upper bound on a single chunk; MediaRecorder emits ~1s slices, far below this. */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export const writeChunkRequestSchema = z
  .object({
    sessionId: idSchema,
    kind: trackKindSchema,
    data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= MAX_CHUNK_BYTES, 'Chunk too large'),
  })
  .strict();

export const trackStartedRequestSchema = z
  .object({
    sessionId: idSchema,
    kind: trackKindSchema,
    /** Milliseconds after the session's reference time that this track's recorder actually started. */
    offsetMs: z.number().min(0).max(60_000),
  })
  .strict();

export const sessionRequestSchema = z.object({ sessionId: idSchema }).strict();

export const stopRecordingRequestSchema = z
  .object({
    sessionId: idSchema,
    title: titleSchema.optional(),
  })
  .strict();

export const abortRecordingRequestSchema = z
  .object({
    sessionId: idSchema,
    reason: z.string().max(1000),
  })
  .strict();

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const librarySortSchema = z.enum(['newest', 'oldest', 'title', 'duration', 'size']);

export const listRecordingsRequestSchema = z
  .object({
    search: z.string().max(200).optional(),
    sort: librarySortSchema.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const recordingIdRequestSchema = z.object({ id: idSchema }).strict();

export const renameRecordingRequestSchema = z
  .object({ id: idSchema, title: titleSchema })
  .strict();

export const deleteRecordingRequestSchema = z
  .object({ id: idSchema, deleteFile: z.boolean() })
  .strict();

// ---------------------------------------------------------------------------
// Jobs / export
// ---------------------------------------------------------------------------

export const exportDestinationSchema = z.enum(['library', 'file', 'replace']);

export const exportRequestSchema = z
  .object({
    recordingId: idSchema,
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    /** accurate = re-encode on exact frames; fast = stream copy (cuts snap to keyframes). */
    mode: z.enum(['accurate', 'fast']),
    quality: qualityPresetSchema,
    destination: exportDestinationSchema,
    /** Required when destination is 'replace': the user explicitly confirmed overwriting the original. */
    confirmReplace: z.boolean().optional(),
  })
  .strict()
  .refine((r) => r.endMs > r.startMs, { message: 'End must be after start', path: ['endMs'] })
  .refine((r) => r.destination !== 'replace' || r.confirmReplace === true, {
    message: 'Replacing the original requires explicit confirmation',
    path: ['confirmReplace'],
  });

export const jobIdRequestSchema = z.object({ jobId: idSchema }).strict();
