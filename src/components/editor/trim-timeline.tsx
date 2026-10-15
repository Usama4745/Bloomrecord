import { useCallback, useRef } from 'react';
import { MIN_SEGMENT_MS } from '@shared/trim';
import { cn, formatDuration } from '@/lib/utils';

/**
 * Scrubber with start/end trim handles. Click or drag the track to seek;
 * drag a handle (or focus it and use arrow keys) to trim.
 */
export function TrimTimeline({
  durationMs,
  startMs,
  endMs,
  currentMs,
  onChange,
  onSeek,
  disabled,
}: {
  durationMs: number;
  startMs: number;
  endMs: number;
  currentMs: number;
  onChange: (startMs: number, endMs: number) => void;
  onSeek: (ms: number) => void;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = (ms: number) => (durationMs > 0 ? (Math.min(Math.max(ms, 0), durationMs) / durationMs) * 100 : 0);

  const msFromEvent = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return Math.round(((clientX - rect.left) / rect.width) * durationMs);
    },
    [durationMs],
  );

  const drag = (which: 'start' | 'end' | 'seek') => (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const apply = (clientX: number) => {
      const ms = Math.min(Math.max(msFromEvent(clientX), 0), durationMs);
      if (which === 'seek') onSeek(ms);
      else if (which === 'start') onChange(Math.min(ms, endMs - MIN_SEGMENT_MS), endMs);
      else onChange(startMs, Math.max(ms, startMs + MIN_SEGMENT_MS));
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const keyStep = (which: 'start' | 'end') => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1000 : 100;
    const delta = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (!delta) return;
    e.preventDefault();
    if (which === 'start') onChange(Math.min(Math.max(0, startMs + delta), endMs - MIN_SEGMENT_MS), endMs);
    else onChange(startMs, Math.max(Math.min(durationMs, endMs + delta), startMs + MIN_SEGMENT_MS));
  };

  return (
    <div className={cn('select-none', disabled && 'pointer-events-none opacity-60')}>
      <div ref={trackRef} className="relative h-14 cursor-pointer rounded-lg bg-muted" onPointerDown={drag('seek')} data-testid="trim-track">
        {/* Excluded regions */}
        <div className="absolute inset-y-0 left-0 rounded-l-lg bg-foreground/10" style={{ width: `${pct(startMs)}%` }} />
        <div className="absolute inset-y-0 right-0 rounded-r-lg bg-foreground/10" style={{ width: `${100 - pct(endMs)}%` }} />
        {/* Selection */}
        <div
          className="absolute inset-y-0 border-y-2 border-primary bg-primary/15"
          style={{ left: `${pct(startMs)}%`, width: `${pct(endMs) - pct(startMs)}%` }}
        />
        {/* Playhead */}
        <div className="pointer-events-none absolute inset-y-[-4px] w-0.5 rounded bg-foreground" style={{ left: `${pct(currentMs)}%` }} />
        <Handle side="start" leftPct={pct(startMs)} label={`Trim start ${formatDuration(startMs, true)}`} onPointerDown={drag('start')} onKeyDown={keyStep('start')} />
        <Handle side="end" leftPct={pct(endMs)} label={`Trim end ${formatDuration(endMs, true)}`} onPointerDown={drag('end')} onKeyDown={keyStep('end')} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{formatDuration(0)}</span>
        <span>{formatDuration(durationMs)}</span>
      </div>
    </div>
  );
}

function Handle({
  side,
  leftPct,
  label,
  onPointerDown,
  onKeyDown,
}: {
  side: 'start' | 'end';
  leftPct: number;
  label: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={Math.round(leftPct)}
      aria-valuemin={0}
      aria-valuemax={100}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute inset-y-0 z-10 flex w-3.5 cursor-ew-resize items-center justify-center bg-primary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        side === 'start' ? '-translate-x-full rounded-l-md' : 'rounded-r-md',
      )}
      style={{ left: `${leftPct}%` }}
    >
      <span className="h-5 w-0.5 rounded bg-primary-foreground/80" />
    </div>
  );
}
