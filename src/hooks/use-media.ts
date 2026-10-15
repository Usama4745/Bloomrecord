import { useEffect, useRef, useState } from 'react';
import { describeMediaError, errorMessage } from '@/services/bloom';
import { acquireCamera, acquireMicrophone, listDevices, stopStream, type DeviceInfo } from '@/services/media-devices';

/** Enumerates cameras and microphones, refreshing on hot-plug. */
export function useDevices(refreshKey: unknown = null) {
  const [devices, setDevices] = useState<{ cameras: DeviceInfo[]; microphones: DeviceInfo[] }>({ cameras: [], microphones: [] });
  useEffect(() => {
    let alive = true;
    const load = () =>
      listDevices()
        .then((d) => alive && setDevices(d))
        .catch(() => {});
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', load);
    };
  }, [refreshKey]);
  return devices;
}

export interface StreamState {
  stream: MediaStream | null;
  error: string | null;
  denied: boolean;
  loading: boolean;
}

/** Keeps a live camera or microphone stream for the selected device; releases it on change/unmount. */
export function useDeviceStream(kind: 'camera' | 'mic', enabled: boolean, deviceId: string | null, highRes = false): StreamState {
  const [state, setState] = useState<StreamState>({ stream: null, error: null, denied: false, loading: false });
  const current = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      stopStream(current.current);
      current.current = null;
      setState({ stream: null, error: null, denied: false, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const acquire = kind === 'camera' ? acquireCamera(deviceId, highRes) : acquireMicrophone(deviceId);
    acquire
      .then((stream) => {
        if (cancelled) return stopStream(stream);
        stopStream(current.current);
        current.current = stream;
        setState({ stream, error: null, denied: false, loading: false });
        // Device unplugged mid-preview.
        stream.getTracks()[0]?.addEventListener('ended', () => {
          if (current.current === stream) setState({ stream: null, error: 'The device was disconnected.', denied: false, loading: false });
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        setState({
          stream: null,
          error: err instanceof DOMException ? describeMediaError(err) : errorMessage(err),
          denied,
          loading: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [kind, enabled, deviceId, highRes]);

  useEffect(
    () => () => {
      stopStream(current.current);
      current.current = null;
    },
    [],
  );

  return state;
}

/** Live input level (0..1) of an audio stream, for the microphone meter. */
export function useAudioLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevel(0);
      return;
    }
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let raf = 0;
    let smoothed = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      // Map roughly -60dB..0dB to 0..1.
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const target = Math.min(1, Math.max(0, (db + 60) / 60));
      smoothed = target > smoothed ? target : smoothed * 0.85 + target * 0.15;
      setLevel(smoothed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void ctx.close();
    };
  }, [stream]);
  return level;
}
