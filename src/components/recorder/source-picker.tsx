import { useCallback, useEffect, useState } from 'react';
import { AppWindow, Monitor, MonitorUp, RefreshCw } from 'lucide-react';
import type { CaptureSource, PlatformCapabilities } from '@shared/recording-types';
import { bloom, errorMessage } from '@/services/bloom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/primitives';

export const SYSTEM_PICKER_SOURCE = 'system-picker';

export function SourcePicker({
  value,
  onChange,
  platform,
}: {
  value: CaptureSource | null;
  onChange: (s: CaptureSource | null) => void;
  platform: PlatformCapabilities | null;
}) {
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const systemPicker = platform?.usesSystemPicker ?? false;

  const refresh = useCallback(async () => {
    if (systemPicker) return;
    setLoading(true);
    try {
      const list = await bloom.capture.listSources(['screen', 'window']);
      setSources(list);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [systemPicker]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // Keep the selection valid; default to the primary screen.
  useEffect(() => {
    if (systemPicker) {
      if (value?.id !== SYSTEM_PICKER_SOURCE) {
        onChange({ id: SYSTEM_PICKER_SOURCE, name: 'Chosen when recording starts', kind: 'screen', thumbnailDataUrl: '', appIconDataUrl: null, displayId: null });
      }
      return;
    }
    if (!sources) return;
    if (!value || !sources.some((s) => s.id === value.id)) onChange(sources.find((s) => s.kind === 'screen') ?? sources[0] ?? null);
  }, [sources, value, onChange, systemPicker]);

  if (systemPicker) {
    return (
      <div className="flex items-center gap-4 rounded-xl border bg-card p-5">
        <MonitorUp className="size-8 text-primary" />
        <div className="text-sm">
          <p className="font-medium">Your desktop will ask what to share</p>
          <p className="text-muted-foreground">{platform?.screenPermissionNote}</p>
        </div>
      </div>
    );
  }

  const visible = (sources ?? []).filter((s) => s.kind === tab);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Segmented
          ariaLabel="Source type"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'screen', label: 'Screens', icon: <Monitor /> },
            { value: 'window', label: 'Windows', icon: <AppWindow /> },
          ]}
        />
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn(loading && 'animate-spin')} /> Refresh
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid max-h-[340px] grid-cols-2 gap-3 overflow-y-auto pr-1 xl:grid-cols-3" role="listbox" aria-label="Capture sources">
        {sources === null &&
          Array.from({ length: 3 }, (_, i) => <div key={i} className="aspect-video animate-pulse rounded-lg bg-muted" />)}
        {sources !== null && visible.length === 0 && (
          <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
            {tab === 'window' ? 'No windows available to capture.' : 'No screens found.'}
            {platform?.platform === 'darwin' && ' Check Screen Recording permission in System Settings.'}
          </p>
        )}
        {visible.map((s) => (
          <button
            key={s.id}
            type="button"
            role="option"
            aria-selected={value?.id === s.id}
            onClick={() => onChange(s)}
            className={cn(
              'group flex flex-col gap-1.5 rounded-lg border-2 border-transparent p-1.5 text-left transition-colors hover:bg-accent/50',
              value?.id === s.id && 'border-primary bg-accent/40',
            )}
          >
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted">
              {s.thumbnailDataUrl ? <img src={s.thumbnailDataUrl} alt="" className="size-full object-contain" draggable={false} /> : <Monitor className="size-6 text-muted-foreground" />}
            </div>
            <div className="flex items-center gap-1.5 px-0.5">
              {s.appIconDataUrl && <img src={s.appIconDataUrl} alt="" className="size-4" />}
              <span className="truncate text-xs font-medium">{s.name}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
