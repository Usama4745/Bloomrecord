import type { FrameRate, ResolutionPreset } from '@shared/recording-types';
import { bloom } from './bloom';
import { RESOLUTION_BOUNDS } from './media-support';

export interface DeviceInfo {
  deviceId: string;
  label: string;
}

export async function listDevices(): Promise<{ cameras: DeviceInfo[]; microphones: DeviceInfo[] }> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const map = (kind: MediaDeviceKind, fallback: string) =>
    devices
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'communications')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  return { cameras: map('videoinput', 'Camera'), microphones: map('audioinput', 'Microphone') };
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function acquireCamera(deviceId: string | null, highRes: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: highRes ? 1920 : 1280 },
      height: { ideal: highRes ? 1080 : 720 },
      frameRate: { ideal: 30 },
    },
  });
}

export async function acquireMicrophone(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

export interface ScreenCapture {
  /** Video-only stream of the selected screen/window. */
  video: MediaStream;
  /** System audio (loopback) if requested and supported. */
  audio: MediaStream | null;
}

/**
 * Captures the source chosen in our picker. Main is told which source to
 * hand out first; getDisplayMedia() then resolves with exactly that source.
 */
export async function acquireScreen(opts: {
  sourceId: string;
  systemAudio: boolean;
  resolution: ResolutionPreset;
  frameRate: FrameRate;
}): Promise<ScreenCapture> {
  await bloom.capture.prepareSource(opts.sourceId, opts.systemAudio);
  const bounds = opts.resolution === 'native' ? null : RESOLUTION_BOUNDS[opts.resolution];
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: opts.systemAudio,
    video: {
      frameRate: { ideal: opts.frameRate, max: opts.frameRate },
      ...(bounds ? { width: { max: bounds.width }, height: { max: bounds.height } } : {}),
    },
  });
  const [videoTrack] = stream.getVideoTracks();
  if (!videoTrack) {
    stopStream(stream);
    throw new Error('The selected source did not provide video.');
  }
  // Hint the encoder that this is screen content (sharper text).
  if ('contentHint' in videoTrack) videoTrack.contentHint = 'detail';
  const audioTracks = stream.getAudioTracks();
  return { video: new MediaStream([videoTrack]), audio: audioTracks.length ? new MediaStream(audioTracks) : null };
}
