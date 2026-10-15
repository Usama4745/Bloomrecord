// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BloomApi } from '@shared/ipc-contracts';
import type { RecordingSummary } from '@shared/recording-types';
import { TrimTimeline } from '@/components/editor/trim-timeline';
import { RecordingCard } from '@/components/library/recording-card';
import { LibraryPage } from '@/components/library/library-page';
import { TooltipProvider } from '@/components/ui/overlays';
import { useAppStore } from '@/stores/app-store';
import { formatBytes, formatDuration } from '@/lib/utils';

const rec = (over: Partial<RecordingSummary> = {}): RecordingSummary => ({
  id: '3f1c4d4e-8a52-4c1e-9a0b-2b7f5d7e9c11',
  title: 'Quarterly demo',
  fileName: 'Quarterly demo.mp4',
  durationMs: 75_000,
  width: 1920,
  height: 1080,
  fileSize: 12_345_678,
  status: 'ready',
  error: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  hasCamera: true,
  hasAudio: true,
  sourceRecordingId: null,
  sessionId: 'a3f1c4d4-8a52-4c1e-9a0b-2b7f5d7e9c11',
  fileMissing: false,
  mediaUrl: 'bloom-media://recording/x',
  thumbnailUrl: null,
  ...over,
});

function installBloom(list: RecordingSummary[]) {
  const api = {
    library: {
      list: vi.fn(async (req: { search?: string }) => list.filter((r) => !req.search || r.title.toLowerCase().includes(req.search.toLowerCase()))),
      stats: vi.fn(),
      reveal: vi.fn(),
    },
    settings: { openOutputDir: vi.fn() },
    on: vi.fn(() => () => {}),
  } as unknown as BloomApi;
  (window as unknown as { bloom: BloomApi }).bloom = api;
  return api;
}

beforeEach(() => {
  useAppStore.setState({ route: { name: 'library' }, navigationLocked: false, libraryVersion: 0 });
});

describe('formatting helpers', () => {
  it('formats durations and sizes', () => {
    expect(formatDuration(75_000)).toBe('1:15');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(1500, true)).toBe('0:01.5');
    expect(formatDuration(null)).toBe('–:––');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12_345_678)).toBe('11.8 MB');
  });
});

describe('TrimTimeline', () => {
  it('moves handles with the keyboard and keeps the minimum gap', () => {
    const onChange = vi.fn();
    render(<TrimTimeline durationMs={10_000} startMs={0} endMs={10_000} currentMs={0} onChange={onChange} onSeek={() => {}} />);
    const start = screen.getByRole('slider', { name: /Trim start/ });
    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(100, 10_000);
    fireEvent.keyDown(start, { key: 'ArrowRight', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(1000, 10_000);
    const end = screen.getByRole('slider', { name: /Trim end/ });
    fireEvent.keyDown(end, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(0, 9900);
  });

  it('never lets the start pass the end', () => {
    const onChange = vi.fn();
    render(<TrimTimeline durationMs={10_000} startMs={4800} endMs={5000} currentMs={0} onChange={onChange} onSeek={() => {}} />);
    fireEvent.keyDown(screen.getByRole('slider', { name: /Trim start/ }), { key: 'ArrowRight', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(4500, 5000);
  });
});

describe('RecordingCard', () => {
  it('shows metadata for ready recordings and opens the player', async () => {
    installBloom([]);
    render(
      <TooltipProvider>
        <RecordingCard rec={rec()} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Quarterly demo')).toBeInTheDocument();
    expect(screen.getByText('1:15')).toBeInTheDocument();
    expect(screen.getByText(/1080p · 11\.8 MB/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Quarterly demo' }));
    expect(useAppStore.getState().route).toEqual({ name: 'player', id: rec().id });
  });

  it('flags missing files and failed processing without crashing', () => {
    installBloom([]);
    const { rerender } = render(
      <TooltipProvider>
        <RecordingCard rec={rec({ fileMissing: true, mediaUrl: null })} />
      </TooltipProvider>,
    );
    expect(screen.getByText('File missing')).toBeInTheDocument();
    rerender(
      <TooltipProvider>
        <RecordingCard rec={rec({ status: 'failed', error: 'A source file is damaged', durationMs: null })} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/A source file is damaged/)).toBeInTheDocument();
  });
});

describe('LibraryPage', () => {
  it('lists, searches and shows an empty search state', async () => {
    const api = installBloom([rec(), rec({ id: '4f1c4d4e-8a52-4c1e-9a0b-2b7f5d7e9c11', title: 'Bug repro' })]);
    render(
      <TooltipProvider>
        <LibraryPage />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('recording-card')).toHaveLength(2));
    await userEvent.type(screen.getByRole('textbox', { name: 'Search recordings' }), 'bug');
    await waitFor(() => expect(screen.getAllByTestId('recording-card')).toHaveLength(1));
    expect(api.library.list).toHaveBeenLastCalledWith({ search: 'bug', sort: 'newest' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Search recordings' }), 'zzz');
    await waitFor(() => expect(screen.getByText(/No recordings match/)).toBeInTheDocument());
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    });
    await waitFor(() => expect(screen.getAllByTestId('recording-card')).toHaveLength(2));
  });

  it('refetches when the library changes', async () => {
    const api = installBloom([rec()]);
    render(
      <TooltipProvider>
        <LibraryPage />
      </TooltipProvider>,
    );
    await waitFor(() => expect(api.library.list).toHaveBeenCalledTimes(1));
    act(() => useAppStore.getState().bumpLibrary());
    await waitFor(() => expect(api.library.list).toHaveBeenCalledTimes(2));
  });
});
