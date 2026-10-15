import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@shared/recording-types';
import { bloom, errorMessage } from '@/services/bloom';
import { BackgroundProcessor, type BackgroundOptions } from '@/services/background-effect';

export type BackgroundStatus = 'off' | 'loading' | 'active' | 'error';

export interface BackgroundState {
  /** Stream to preview and record: processed when an effect is active, the raw camera when off, null while loading or on error. */
  stream: MediaStream | null;
  status: BackgroundStatus;
  error: string | null;
}

/** Decodes the user's custom background image when it is selected. */
function useCustomImage(fileName: string | null, wanted: boolean): ImageBitmap | null {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    if (!wanted || !fileName) {
      setBitmap(null);
      return;
    }
    let cancelled = false;
    let created: ImageBitmap | null = null;
    bloom.settings
      .getBackgroundImage()
      .then(async (img) => {
        if (!img || cancelled) return;
        created = await createImageBitmap(new Blob([img.data as BlobPart], { type: img.mimeType }));
        if (cancelled) created.close();
        else setBitmap(created);
      })
      .catch(() => !cancelled && setBitmap(null));
    return () => {
      cancelled = true;
      created?.close();
    };
  }, [fileName, wanted]);
  return bitmap;
}

/**
 * Applies the configured webcam background effect to a camera stream.
 * Falls back to "no stream" rather than the raw camera if an effect was
 * requested but fails, so a blurred background is never silently recorded unblurred.
 */
export function useBackgroundEffect(raw: MediaStream | null, settings: Settings): BackgroundState {
  const { backgroundEffect: effect, backgroundBlur: blur, backgroundPreset: preset, backgroundCustomImage } = settings;
  const customImage = useCustomImage(backgroundCustomImage, effect === 'image' && preset === 'custom');
  const [state, setState] = useState<BackgroundState>({ stream: raw, status: 'off', error: null });
  const processorRef = useRef<BackgroundProcessor | null>(null);
  const optionsRef = useRef<BackgroundOptions | null>(null);
  const enabled = effect !== 'none';

  optionsRef.current = enabled ? { effect: effect as BackgroundOptions['effect'], blur, preset, customImage } : null;

  // (Re)create the processor when the camera stream changes or effects are toggled on/off.
  useEffect(() => {
    if (!raw || !enabled) {
      setState({ stream: raw, status: 'off', error: null });
      return;
    }
    let cancelled = false;
    setState({ stream: null, status: 'loading', error: null });
    BackgroundProcessor.create(raw, optionsRef.current!, (err) => {
      if (!cancelled) setState({ stream: null, status: 'error', error: `Background effect stopped: ${errorMessage(err)}` });
    })
      .then((p) => {
        if (cancelled) return p.stop();
        processorRef.current = p;
        setState({ stream: p.stream, status: 'active', error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ stream: null, status: 'error', error: `Background effect unavailable: ${errorMessage(err)}` });
      });
    return () => {
      cancelled = true;
      processorRef.current?.stop();
      processorRef.current = null;
    };
  }, [raw, enabled]);

  // Option changes (blur strength, preset, custom image) apply live.
  useEffect(() => {
    if (processorRef.current && optionsRef.current) processorRef.current.setOptions(optionsRef.current);
  }, [effect, blur, preset, customImage, state.status]);

  return state;
}
