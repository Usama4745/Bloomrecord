import type { QualityPreset, ResolutionPreset, TrackKind } from '@shared/recording-types';

/**
 * MediaRecorder container/codec support differs between platforms and
 * Chromium builds, so candidates are probed at runtime. VP8 WebM is the most
 * broadly reliable real-time encoder; the final MP4 is produced by FFmpeg.
 */
export const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm;codecs=h264',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
];

export const AUDIO_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

export function pickMimeType(kind: TrackKind, isSupported: (mime: string) => boolean = (m) => MediaRecorder.isTypeSupported(m)): string | null {
  const candidates = kind === 'screen' || kind === 'camera' ? VIDEO_MIME_CANDIDATES : AUDIO_MIME_CANDIDATES;
  return candidates.find((m) => isSupported(m)) ?? null;
}

const SCREEN_BITRATE: Record<ResolutionPreset, number> = {
  '720p': 5_000_000,
  '1080p': 9_000_000,
  '1440p': 14_000_000,
  '2160p': 24_000_000,
  native: 12_000_000,
};
const QUALITY_FACTOR: Record<QualityPreset, number> = { low: 0.5, medium: 0.75, high: 1 };

/** Intermediate bitrates are generous because the final encode happens in FFmpeg. */
export function bitrateFor(kind: TrackKind, resolution: ResolutionPreset, quality: QualityPreset, frameRate: number): number {
  const q = QUALITY_FACTOR[quality];
  const fpsFactor = frameRate > 30 ? 1.5 : 1;
  switch (kind) {
    case 'screen':
      return Math.round(SCREEN_BITRATE[resolution] * q * fpsFactor);
    case 'camera':
      return Math.round(4_000_000 * q);
    default:
      return 128_000;
  }
}

export const RESOLUTION_BOUNDS: Record<Exclude<ResolutionPreset, 'native'>, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
};
