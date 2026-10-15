import { useEffect, useRef } from 'react';
import { MicOff, ShieldAlert } from 'lucide-react';
import type { BubblePosition, MediaPermission } from '@shared/recording-types';
import { bloom } from '@/services/bloom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** <video> bound to a live MediaStream. */
export function StreamVideo({ stream, className, mirrored }: { stream: MediaStream | null; className?: string; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline className={cn('bg-black', mirrored && '-scale-x-100', className)} />;
}

export function MicMeter({ level, muted, className }: { level: number; muted?: boolean; className?: string }) {
  const bars = 16;
  const lit = Math.round(level * bars);
  return (
    <div className={cn('flex h-4 items-end gap-[3px]', className)} role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      {muted ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <MicOff className="size-3.5" /> No microphone
        </span>
      ) : (
        Array.from({ length: bars }, (_, i) => (
          <span
            key={i}
            className={cn(
              'w-1 rounded-full transition-colors duration-75',
              i < lit ? (i >= bars - 2 ? 'bg-destructive' : i >= bars - 5 ? 'bg-warning' : 'bg-success') : 'bg-muted',
            )}
            style={{ height: `${35 + (i / bars) * 65}%` }}
          />
        ))
      )}
    </div>
  );
}

const PERMISSION_LABEL: Record<MediaPermission, string> = { camera: 'camera', microphone: 'microphone', screen: 'screen recording' };

export function PermissionNotice({ kind, message, platform }: { kind: MediaPermission; message: string; platform: NodeJS.Platform | undefined }) {
  const canOpen = platform === 'darwin' || (platform === 'win32' && kind !== 'screen');
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex-1">
        <p className="font-medium">BloomRecord can't access your {PERMISSION_LABEL[kind]}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{message}</p>
        {platform === 'darwin' && (
          <p className="mt-1 text-xs text-muted-foreground">Open System Settings → Privacy &amp; Security, enable BloomRecord, then restart the app.</p>
        )}
        {platform === 'win32' && kind !== 'screen' && (
          <p className="mt-1 text-xs text-muted-foreground">Open Settings → Privacy &amp; security → {kind === 'camera' ? 'Camera' : 'Microphone'} and allow desktop apps to access it.</p>
        )}
        {platform === 'linux' && <p className="mt-1 text-xs text-muted-foreground">Check that no other application is using the device and that your user can access it.</p>}
      </div>
      {canOpen && (
        <Button size="sm" variant="outline" onClick={() => void bloom.capture.openPermissionSettings(kind)}>
          Open settings
        </Button>
      )}
    </div>
  );
}

const CORNERS: BubblePosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** Four-corner picker for the webcam bubble. */
export function BubblePositionPicker({ value, onChange }: { value: BubblePosition; onChange: (p: BubblePosition) => void }) {
  return (
    <div role="radiogroup" aria-label="Webcam bubble position" className="relative grid aspect-video w-28 grid-cols-2 grid-rows-2 gap-1 rounded-md border bg-muted p-1">
      {CORNERS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c.replace('-', ' ')}
          onClick={() => onChange(c)}
          className={cn('flex rounded-sm hover:bg-card', c.startsWith('top') ? 'items-start' : 'items-end', c.endsWith('left') ? 'justify-start' : 'justify-end')}
        >
          <span className={cn('m-0.5 size-3 rounded-full border-2 border-muted-foreground/40', value === c && 'border-primary bg-primary')} />
        </button>
      ))}
    </div>
  );
}

const BUBBLE_FRACTION = { small: 0.18, medium: 0.25, large: 0.33 } as const;

/** Visual preview of the final composition: screen with the circular camera bubble. */
export function CompositionPreview({
  screen,
  camera,
  bubblePosition,
  bubbleSize,
  className,
}: {
  screen: React.ReactNode;
  camera: MediaStream | null;
  bubblePosition: BubblePosition;
  bubbleSize: keyof typeof BUBBLE_FRACTION;
  className?: string;
}) {
  const pct = BUBBLE_FRACTION[bubbleSize] * 100;
  return (
    <div className={cn('@container relative aspect-video overflow-hidden rounded-xl bg-black', className)}>
      {screen}
      {camera && (
        <div
          className="absolute overflow-hidden rounded-full shadow-xl ring-2 ring-white/20"
          style={{
            height: `${pct}%`,
            aspectRatio: '1 / 1',
            [bubblePosition.startsWith('top') ? 'top' : 'bottom']: '3.5%',
            [bubblePosition.endsWith('left') ? 'left' : 'right']: `${3.5 * (9 / 16)}%`,
          }}
        >
          <StreamVideo stream={camera} mirrored className="size-full object-cover" />
        </div>
      )}
    </div>
  );
}
