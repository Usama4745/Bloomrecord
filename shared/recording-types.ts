import type { z } from 'zod';
import type {
  bubblePositionSchema,
  bubbleSizeSchema,
  exportRequestSchema,
  frameRateSchema,
  librarySortSchema,
  listRecordingsRequestSchema,
  mediaPermissionSchema,
  qualityPresetSchema,
  recordingModeSchema,
  resolutionPresetSchema,
  settingsPatchSchema,
  settingsSchema,
  startRecordingRequestSchema,
  themeSchema,
  backgroundEffectSchema,
  backgroundBlurSchema,
  backgroundPresetSchema,
  trackKindSchema,
  trackSpecSchema,
} from './validation';

export type RecordingMode = z.infer<typeof recordingModeSchema>;
export type TrackKind = z.infer<typeof trackKindSchema>;
export type TrackSpec = z.infer<typeof trackSpecSchema>;
export type BubblePosition = z.infer<typeof bubblePositionSchema>;
export type BubbleSize = z.infer<typeof bubbleSizeSchema>;
export type QualityPreset = z.infer<typeof qualityPresetSchema>;
export type ResolutionPreset = z.infer<typeof resolutionPresetSchema>;
export type FrameRate = z.infer<typeof frameRateSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type BackgroundEffect = z.infer<typeof backgroundEffectSchema>;
export type BackgroundBlur = z.infer<typeof backgroundBlurSchema>;
export type BackgroundPreset = z.infer<typeof backgroundPresetSchema>;

export interface BackgroundImageData {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: Uint8Array;
}
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type StartRecordingRequest = z.infer<typeof startRecordingRequestSchema>;
export type ListRecordingsRequest = z.infer<typeof listRecordingsRequestSchema>;
export type LibrarySort = z.infer<typeof librarySortSchema>;
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type MediaPermission = z.infer<typeof mediaPermissionSchema>;

export type PermissionStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
  displayId: string | null;
}

export interface PlatformCapabilities {
  platform: NodeJS.Platform;
  arch: string;
  /** System audio (loopback) capture is reliably supported on this platform. */
  systemAudio: boolean;
  systemAudioNote: string | null;
  /** The OS shows its own picker instead of our source list (Wayland portals). */
  usesSystemPicker: boolean;
  screenPermissionNote: string | null;
  isWayland: boolean;
}

export type SessionStatus =
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'discarded';

export interface PauseInterval {
  startedAt: number;
  endedAt: number | null;
}

export interface RecordingStatusEvent {
  sessionId: string;
  status: SessionStatus;
  activeDurationMs: number;
  bytesWritten: number;
  error: string | null;
}

export interface StartRecordingResponse {
  sessionId: string;
  /** Epoch ms the session was opened in main; renderer offsets are measured from its own reference. */
  createdAt: number;
}

export interface StopRecordingResponse {
  recordingId: string;
  jobId: string;
}

export interface InterruptedSession {
  sessionId: string;
  startedAt: number;
  mode: RecordingMode;
  status: SessionStatus;
  activeDurationMs: number;
  bytesWritten: number;
  tracks: TrackKind[];
  error: string | null;
  recordingId: string | null;
}

export type RecordingStatus = 'processing' | 'ready' | 'failed';

export interface RecordingSummary {
  id: string;
  title: string;
  fileName: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  status: RecordingStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  hasCamera: boolean;
  hasAudio: boolean;
  sourceRecordingId: string | null;
  /** Capture session that produced this recording (for retrying failed processing). */
  sessionId: string | null;
  /** True when the media file no longer exists at its recorded location. */
  fileMissing: boolean;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
}

export interface LibraryStats {
  recordingCount: number;
  totalBytes: number;
  outputDir: string;
  freeBytes: number | null;
}

export type JobKind = 'compose' | 'export';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobInfo {
  id: string;
  kind: JobKind;
  label: string;
  recordingId: string | null;
  status: JobStatus;
  /** 0..1, or null when the total duration is unknown. */
  progress: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  outputPath: string | null;
  canRetry: boolean;
}

export interface Diagnostics {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  ffmpegPath: string;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  userDataDir: string;
  databasePath: string;
  tempDir: string;
  tempBytes: number;
}

export interface CleanupResult {
  removedFiles: number;
  freedBytes: number;
}

export type ShortcutAction = 'toggle-pause' | 'stop';
