import { useState } from 'react';
import { FolderOpen, Search, Video } from 'lucide-react';
import type { LibrarySort } from '@shared/recording-types';
import { useRecordings } from '@/hooks/use-library';
import { bloom, errorMessage } from '@/services/bloom';
import { useAppStore } from '@/stores/app-store';
import { toast } from '@/stores/toast-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/primitives';
import { Select } from '@/components/ui/overlays';
import { RecordingCard } from './recording-card';

const SORTS: Array<{ value: LibrarySort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'duration', label: 'Longest' },
  { value: 'size', label: 'Largest' },
];

export function LibraryPage({ initialSearch }: { initialSearch?: string }) {
  const navigate = useAppStore((s) => s.navigate);
  const [search, setSearch] = useState(initialSearch ?? '');
  const [sort, setSort] = useState<LibrarySort>('newest');
  const { items, error } = useRecordings({ search: search.trim() || undefined, sort });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">{items ? `${items.length} recording${items.length === 1 ? '' : 's'}` : 'Loading…'}</p>
        </div>
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search recordings" placeholder="Search by title…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select<LibrarySort> ariaLabel="Sort recordings" className="w-40" value={sort} onValueChange={setSort} options={SORTS} />
        <Button variant="outline" onClick={() => bloom.settings.openOutputDir().catch((err) => toast.error(errorMessage(err)))}>
          <FolderOpen /> Open folder
        </Button>
      </header>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {items && items.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
          {search ? (
            <>
              <h3 className="font-semibold">No recordings match “{search}”</h3>
              <Button variant="link" onClick={() => setSearch('')}>
                Clear search
              </Button>
            </>
          ) : (
            <>
              <h3 className="font-semibold">Your library is empty</h3>
              <p className="mt-1 text-sm text-muted-foreground">Recordings you make appear here.</p>
              <Button className="mt-4" variant="record" onClick={() => navigate({ name: 'record' })}>
                <Video /> New recording
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4" data-testid="library-grid">
          {(items ?? []).map((r) => (
            <RecordingCard key={r.id} rec={r} />
          ))}
        </div>
      )}
    </div>
  );
}
