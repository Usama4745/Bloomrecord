import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import type { InterruptedSession } from '@shared/recording-types';
import { bloom, errorMessage } from '@/services/bloom';
import { useAppStore } from '@/stores/app-store';
import { toast } from '@/stores/toast-store';
import { formatBytes, formatDate, formatDuration } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/overlays';

/** Lists sessions that were interrupted (crash, quit, write failure) and offers to recover or discard them. */
export function RecoveryBanner() {
  const version = useAppStore((s) => s.libraryVersion);
  const navigate = useAppStore((s) => s.navigate);
  const [sessions, setSessions] = useState<InterruptedSession[]>([]);
  const [discarding, setDiscarding] = useState<InterruptedSession | null>(null);

  const load = useCallback(() => {
    bloom.recording.listInterrupted().then(setSessions).catch(() => {});
  }, []);
  useEffect(load, [load, version]);

  if (sessions.length === 0) return null;

  return (
    <section className="rounded-xl border border-warning/40 bg-warning/10 p-4" aria-label="Recoverable recordings">
      <div className="flex items-start gap-3">
        <LifeBuoy className="mt-0.5 size-5 shrink-0 text-warning" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold">
            {sessions.length === 1 ? 'A recording was interrupted' : `${sessions.length} recordings were interrupted`}
          </h2>
          <p className="text-xs text-muted-foreground">Everything captured before the interruption was saved. Recover it to finish processing.</p>
          <ul className="mt-3 flex flex-col gap-2">
            {sessions.map((s) => (
              <li key={s.sessionId} className="flex items-center gap-3 rounded-lg bg-card/70 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{formatDate(s.startedAt)}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {s.activeDurationMs > 0 ? `~${formatDuration(s.activeDurationMs)} · ` : ''}
                    {formatBytes(s.bytesWritten)} · {s.tracks.join(', ') || 'no data'}
                    {s.error ? ` · ${s.error}` : ''}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setDiscarding(s)}>
                  Discard
                </Button>
                <Button
                  size="sm"
                  disabled={s.bytesWritten === 0}
                  onClick={async () => {
                    try {
                      const { recordingId } = await bloom.recording.recover(s.sessionId);
                      load();
                      navigate({ name: 'player', id: recordingId });
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  Recover
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {discarding && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDiscarding(null)}
          title="Discard this recording?"
          description="The raw captured data will be permanently deleted. This cannot be undone."
          confirmLabel="Discard"
          destructive
          onConfirm={async () => {
            try {
              await bloom.recording.discard(discarding.sessionId);
              load();
            } catch (err) {
              toast.error(errorMessage(err));
            }
            setDiscarding(null);
          }}
        />
      )}
    </section>
  );
}
