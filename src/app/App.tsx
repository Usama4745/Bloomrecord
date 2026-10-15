import { useEffect, useState } from 'react';
import { IpcEvents } from '@shared/ipc-contracts';
import { bloom, errorMessage } from '@/services/bloom';
import { useAppStore } from '@/stores/app-store';
import { useJobsStore } from '@/stores/jobs-store';
import { useRecorderStore } from '@/stores/recorder-store';
import { toast } from '@/stores/toast-store';
import { TooltipProvider } from '@/components/ui/overlays';
import { Sidebar } from '@/components/layout/sidebar';
import { Toaster } from '@/components/layout/toaster';
import { DashboardPage } from '@/components/dashboard/dashboard-page';
import { RecorderPage } from '@/components/recorder/recorder-page';
import { LibraryPage } from '@/components/library/library-page';
import { PlayerPage } from '@/components/player/player-page';
import { SettingsPage } from '@/components/settings/settings-page';
import { Loader2 } from 'lucide-react';

function useTheme() {
  const theme = useAppStore((s) => s.settings?.theme ?? 'system');
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function useMainEvents() {
  useEffect(() => {
    const { upsert, setAll } = useJobsStore.getState();
    bloom.jobs.list().then(setAll).catch(() => {});
    const offs = [
      bloom.on(IpcEvents.jobUpdate, (job) => {
        const prev = useJobsStore.getState().jobs[job.id];
        upsert(job);
        if (prev?.status !== job.status) {
          if (job.status === 'completed' && job.kind === 'export') toast.success(`${job.label.replace(/^(Exporting|Saving|Trimming)/, 'Finished')}`);
          if (job.status === 'failed') toast.error(`${job.label} failed: ${job.error ?? 'unknown error'}`);
        }
      }),
      bloom.on(IpcEvents.libraryChanged, () => useAppStore.getState().bumpLibrary()),
      bloom.on(IpcEvents.shortcut, ({ action }) => {
        const r = useRecorderStore.getState();
        if (action === 'toggle-pause') void r.togglePause();
        if (action === 'stop') void r.stop();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}

export function App() {
  const route = useAppStore((s) => s.route);
  const loaded = useAppStore((s) => s.settings !== null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useTheme();
  useMainEvents();

  useEffect(() => {
    useAppStore
      .getState()
      .load()
      .catch((err) => setLoadError(errorMessage(err)));
  }, []);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="font-semibold">BloomRecord could not load its settings.</p>
          <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full">
        <Sidebar />
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          {route.name === 'dashboard' && <DashboardPage />}
          {route.name === 'record' && <RecorderPage />}
          {route.name === 'library' && <LibraryPage initialSearch={route.search} />}
          {route.name === 'player' && <PlayerPage key={route.id} id={route.id} />}
          {route.name === 'settings' && <SettingsPage />}
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
