import { useEffect, useState } from 'react';
import { Check, ImagePlus } from 'lucide-react';
import type { BackgroundPreset, Settings } from '@shared/recording-types';
import { BACKGROUND_PRESET_IDS } from '@shared/validation';
import { bloom, errorMessage } from '@/services/bloom';
import { BACKGROUND_PRESETS, presetCss } from '@/services/background-presets';
import { backgroundEffectsSupported } from '@/services/background-effect';
import { useAppStore } from '@/stores/app-store';
import { toast } from '@/stores/toast-store';
import { cn } from '@/lib/utils';
import { Segmented } from '@/components/ui/primitives';

/** Object URL for the custom background thumbnail. */
function useCustomThumb(fileName: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!fileName) {
      setUrl(null);
      return;
    }
    let created: string | null = null;
    let cancelled = false;
    bloom.settings
      .getBackgroundImage()
      .then((img) => {
        if (!img || cancelled) return;
        created = URL.createObjectURL(new Blob([img.data as BlobPart], { type: img.mimeType }));
        setUrl(created);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [fileName]);
  return url;
}

export function BackgroundPicker({ settings, compact }: { settings: Settings; compact?: boolean }) {
  const update = useAppStore((s) => s.updateSettings);
  const thumb = useCustomThumb(settings.backgroundCustomImage);
  const supported = backgroundEffectsSupported();

  const choose = async () => {
    try {
      const next = await bloom.settings.chooseBackgroundImage();
      if (next) useAppStore.getState().setSettings(next);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const select = (preset: BackgroundPreset) => void update({ backgroundEffect: 'image', backgroundPreset: preset });

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        ariaLabel="Camera background"
        value={settings.backgroundEffect}
        disabled={!supported}
        onChange={(v) => void update({ backgroundEffect: v })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'blur', label: 'Blur' },
          { value: 'image', label: 'Replace' },
        ]}
      />
      {!supported && <p className="text-xs text-muted-foreground">Background effects are not supported on this system.</p>}

      {settings.backgroundEffect === 'blur' && (
        <Segmented
          ariaLabel="Blur strength"
          value={settings.backgroundBlur}
          onChange={(v) => void update({ backgroundBlur: v })}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'strong', label: 'Strong' },
          ]}
        />
      )}

      {settings.backgroundEffect === 'image' && (
        <div className={cn('grid gap-2', compact ? 'grid-cols-4' : 'grid-cols-7')} role="radiogroup" aria-label="Background image">
          {BACKGROUND_PRESET_IDS.map((id) => (
            <Swatch key={id} label={BACKGROUND_PRESETS[id].label} selected={settings.backgroundPreset === id} onClick={() => select(id)} style={{ background: presetCss(id) }} />
          ))}
          {thumb ? (
            <Swatch
              label="Your image"
              selected={settings.backgroundPreset === 'custom'}
              onClick={() => select('custom')}
              style={{ backgroundImage: `url(${thumb})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
            />
          ) : null}
          <button
            type="button"
            onClick={() => void choose()}
            title="Upload an image"
            aria-label="Upload a background image"
            className="flex aspect-video items-center justify-center rounded-md border border-dashed text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <ImagePlus className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function Swatch({ label, selected, onClick, style }: { label: string; selected: boolean; onClick: () => void; style: React.CSSProperties }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={style}
      className={cn('relative flex aspect-video items-center justify-center rounded-md ring-offset-2 ring-offset-card', selected ? 'ring-2 ring-primary' : 'ring-1 ring-border')}
    >
      {selected && <Check className="size-3.5 text-white drop-shadow" />}
    </button>
  );
}
