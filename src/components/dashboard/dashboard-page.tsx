import { useState } from 'react';
import { ArrowRight, Film, HardDrive, Search, ShieldCheck, Video } from 'lucide-react';
import { useLibraryStats, useRecordings } from '@/hooks/use-library';
import { useAppStore } from '@/stores/app-store';
import { formatBytes } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, Input } from '@/components/ui/primitives';
import { RecordingCard } from '@/components/library/recording-card';
import { RecoveryBanner } from './recovery-banner';

export function DashboardPage() {
  const navigate = useAppStore((s) => s.navigate);
  const { items } = useRecordings({ limit: 8 });
  const stats = useLibraryStats();
  const [search, setSearch] = useState('');

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <header className="flex flex-wrap items-center gap-4">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">Record your screen and camera. Everything stays on this computer.</p>
        </div>
        <form
          className="relative w-72"
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ name: 'library', search: search.trim() || undefined });
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search recordings" placeholder="Search recordings…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
        <Button size="lg" variant="record" onClick={() => navigate({ name: 'record' })} data-testid="new-recording">
          <Video /> New recording
        </Button>
      </header>

      <RecoveryBanner />

      <div className="grid grid-cols-3 gap-4">
        <StatCard icon={<Film />} label="Recordings" value={stats ? String(stats.recordingCount) : '—'} />
        <StatCard icon={<HardDrive />} label="Storage used" value={stats ? formatBytes(stats.totalBytes) : '—'} hint={stats?.outputDir} />
        <StatCard icon={<HardDrive />} label="Free space" value={stats?.freeBytes != null ? formatBytes(stats.freeBytes) : '—'} />
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Recent recordings</h2>
          {items && items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'library' })}>
              View all <ArrowRight />
            </Button>
          )}
        </div>
        {items === null ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState onRecord={() => navigate({ name: 'record' })} />
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {items.map((r) => (
              <RecordingCard key={r.id} rec={r} />
            ))}
          </div>
        )}
      </section>

      <Card className="flex items-start gap-3 p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
        <div className="text-sm">
          <p className="font-medium">Private by design</p>
          <p className="text-muted-foreground">
            BloomRecord works fully offline. Recordings, thumbnails and settings are stored only on this device — there is no account, no upload and no
            telemetry.
          </p>
        </div>
      </Card>
    </div>
  );
}

function StatCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <Card className="flex items-center gap-4 p-4">
      <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground [&_svg]:size-5">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
        {hint && (
          <div className="truncate text-[11px] text-muted-foreground" title={hint} data-selectable>
            {hint}
          </div>
        )}
      </div>
    </Card>
  );
}

function EmptyState({ onRecord }: { onRecord: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Video className="size-6" />
      </div>
      <h3 className="text-base font-semibold">No recordings yet</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">Capture your screen with a webcam bubble and narration. Your first recording is a click away.</p>
      <Button className="mt-5" variant="record" onClick={onRecord}>
        <Video /> Start your first recording
      </Button>
    </div>
  );
}
