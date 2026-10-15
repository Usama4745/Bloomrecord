import { Film, LayoutDashboard, Loader2, Settings, Video } from 'lucide-react';
import { useAppStore, type Route } from '@/stores/app-store';
import { isActive, useJobsStore } from '@/stores/jobs-store';
import { useRecorderStore } from '@/stores/recorder-store';
import { cn, formatDuration } from '@/lib/utils';
import { Progress } from '@/components/ui/primitives';
import { Logo } from './logo';

const NAV: Array<{ route: Route['name']; label: string; icon: typeof Film }> = [
  { route: 'dashboard', label: 'Home', icon: LayoutDashboard },
  { route: 'record', label: 'Record', icon: Video },
  { route: 'library', label: 'Library', icon: Film },
  { route: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);
  const locked = useAppStore((s) => s.navigationLocked);
  const recPhase = useRecorderStore((s) => s.phase);
  const elapsed = useRecorderStore((s) => s.elapsedMs);
  const jobs = useJobsStore((s) => s.jobs);
  const active = Object.values(jobs).filter(isActive);
  const running = active.find((j) => j.status === 'running');
  const capturing = recPhase === 'recording' || recPhase === 'paused';

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 text-sidebar-foreground">
      <div className="mb-6 flex items-center gap-2.5 px-2">
        <Logo className="size-8" />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">BloomRecord</div>
          <div className="text-[11px] text-sidebar-muted">Local screen recorder</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5" aria-label="Main">
        {NAV.map(({ route: r, label, icon: Icon }) => {
          const current = route.name === r || (r === 'library' && route.name === 'player');
          return (
            <button
              key={r}
              type="button"
              onClick={() => navigate(r === 'library' ? { name: 'library' } : ({ name: r } as Route))}
              disabled={locked && r !== 'record'}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground disabled:opacity-40 disabled:hover:bg-transparent',
                current && 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent',
              )}
            >
              <Icon className="size-4" />
              {label}
              {r === 'record' && capturing && (
                <span className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-recording tabular-nums">
                  <span className="size-2 rounded-full bg-recording animate-pulse-ring" />
                  {formatDuration(elapsed)}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        {active.length > 0 && (
          <div className="rounded-lg border border-sidebar-border bg-sidebar-accent p-3 text-xs" aria-live="polite">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <Loader2 className="size-3.5 animate-spin" />
              {active.length === 1 ? 'Processing' : `Processing (${active.length})`}
            </div>
            <p className="mb-2 truncate text-sidebar-muted" title={running?.label}>
              {running?.label ?? 'Queued'}
            </p>
            <Progress className="bg-sidebar-border [&>div]:bg-sidebar-foreground" value={(running?.progress ?? 0) * 100} indeterminate={running?.progress === null} />
          </div>
        )}
        <p className="px-2 text-[11px] leading-snug text-sidebar-muted">Recordings stay on this device. No account, no cloud.</p>
      </div>
    </aside>
  );
}
