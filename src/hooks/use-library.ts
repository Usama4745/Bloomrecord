import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryStats, LibrarySort, RecordingSummary } from '@shared/recording-types';
import { bloom, errorMessage } from '@/services/bloom';
import { useAppStore } from '@/stores/app-store';

export function useRecordings(opts: { search?: string; sort?: LibrarySort; limit?: number }) {
  const version = useAppStore((s) => s.libraryVersion);
  const [items, setItems] = useState<RecordingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  const { search, sort, limit } = opts;

  const refresh = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const list = await bloom.library.list({
        ...(search ? { search } : {}),
        ...(sort ? { sort } : {}),
        ...(limit ? { limit } : {}),
      });
      if (id === reqId.current) {
        setItems(list);
        setError(null);
      }
    } catch (err) {
      if (id === reqId.current) setError(errorMessage(err));
    }
  }, [search, sort, limit]);

  useEffect(() => {
    // Debounce search typing.
    const t = setTimeout(() => void refresh(), search ? 150 : 0);
    return () => clearTimeout(t);
  }, [refresh, version, search]);

  return { items, error, refresh };
}

export function useRecording(id: string) {
  const version = useAppStore((s) => s.libraryVersion);
  const [item, setItem] = useState<RecordingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    bloom.library
      .get(id)
      .then((r) => !cancelled && (setItem(r), setError(null)))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [id, version]);
  return { item, error };
}

export function useLibraryStats() {
  const version = useAppStore((s) => s.libraryVersion);
  const settingsDir = useAppStore((s) => s.settings?.outputDir);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  useEffect(() => {
    bloom.library.stats().then(setStats).catch(() => {});
  }, [version, settingsDir]);
  return stats;
}
