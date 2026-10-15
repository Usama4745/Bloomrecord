import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FileVideo, FolderOpen, Loader2, Pencil, Play, Replace, RotateCcw, Scissors, Trash2, TriangleAlert, X } from 'lucide-react';
import type { QualityPreset, RecordingSummary } from '@shared/recording-types';
import { clampTrim, isFullRange, validateTrim } from '@shared/trim';
import { useRecording } from '@/hooks/use-library';
import { bloom, errorMessage } from '@/services/bloom';
import { useAppStore } from '@/stores/app-store';
import { isActive, jobForRecording, useJobsStore } from '@/stores/jobs-store';
import { toast } from '@/stores/toast-store';
import { formatBytes, formatDate, formatDuration, formatResolution } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Select } from '@/components/ui/overlays';
import { Badge, Card, CardContent, CardHeader, CardTitle, Label, Progress, Segmented } from '@/components/ui/primitives';
import { TrimTimeline } from '@/components/editor/trim-timeline';
import { DeleteDialog, RenameDialog, retryProcessing } from '@/components/library/recording-actions';

export function PlayerPage({ id }: { id: string }) {
  const navigate = useAppStore((s) => s.navigate);
  const { item: rec, error } = useRecording(id);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 p-16 text-center">
        <p className="font-medium">{error}</p>
        <Button variant="outline" onClick={() => navigate({ name: 'library' })}>
          Back to library
        </Button>
      </div>
    );
  }
  if (!rec) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-8">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Back to library" onClick={() => navigate({ name: 'library' })}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <button type="button" className="group flex max-w-full items-center gap-2 text-left" onClick={() => setRenaming(true)}>
            <h1 className="truncate text-xl font-semibold tracking-tight" data-testid="player-title">
              {rec.title}
            </h1>
            <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
          </button>
          <p className="text-xs text-muted-foreground">
            {formatDate(rec.createdAt)}
            {rec.status === 'ready' && ` · ${formatDuration(rec.durationMs)} · ${formatResolution(rec.width, rec.height)} · ${formatBytes(rec.fileSize)}`}
          </p>
        </div>
        <Button variant="outline" disabled={rec.status !== 'ready' || rec.fileMissing} onClick={() => bloom.library.reveal(rec.id).catch((err) => toast.error(errorMessage(err)))}>
          <FolderOpen /> Show in folder
        </Button>
        <Button variant="ghost" size="icon" aria-label="Delete recording" disabled={rec.status === 'processing'} onClick={() => setDeleting(true)}>
          <Trash2 />
        </Button>
      </header>

      {rec.status === 'processing' && <ProcessingState rec={rec} />}
      {rec.status === 'failed' && <FailedState rec={rec} />}
      {rec.status === 'ready' && rec.fileMissing && (
        <Card className="flex flex-col items-center gap-2 p-12 text-center">
          <TriangleAlert className="size-8 text-warning" />
          <p className="font-medium">The video file is missing</p>
          <p className="max-w-md text-sm text-muted-foreground" data-selectable>
            {rec.fileName} was moved, renamed or deleted outside BloomRecord. Move it back to the recordings folder, or remove this entry from the library.
          </p>
        </Card>
      )}
      {rec.status === 'ready' && !rec.fileMissing && rec.mediaUrl && <Editor key={`${rec.durationMs}-${rec.fileSize}`} rec={rec} />}

      <RenameDialog rec={rec} open={renaming} onOpenChange={setRenaming} />
      <DeleteDialog rec={rec} open={deleting} onOpenChange={setDeleting} onDeleted={() => navigate({ name: 'library' })} />
    </div>
  );
}

function ProcessingState({ rec }: { rec: RecordingSummary }) {
  const job = useJobsStore((s) => jobForRecording(s.jobs, rec.id, 'compose'));
  return (
    <Card className="flex flex-col items-center gap-4 p-14 text-center" data-testid="processing-state">
      <Loader2 className="size-8 animate-spin text-primary" />
      <div>
        <p className="font-medium">Processing your recording…</p>
        <p className="text-sm text-muted-foreground">Combining screen, camera and audio into an MP4. This happens entirely on your computer.</p>
      </div>
      <div className="flex w-80 items-center gap-3">
        <Progress value={(job?.progress ?? 0) * 100} indeterminate={!job || job.progress === null} />
        <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{job?.progress != null ? `${Math.round(job.progress * 100)}%` : ''}</span>
      </div>
      {job && isActive(job) && (
        <Button variant="ghost" size="sm" onClick={() => void bloom.jobs.cancel(job.id)}>
          Cancel
        </Button>
      )}
    </Card>
  );
}

function FailedState({ rec }: { rec: RecordingSummary }) {
  return (
    <Card className="flex flex-col items-center gap-3 p-12 text-center">
      <TriangleAlert className="size-8 text-destructive" />
      <p className="font-medium">Processing failed</p>
      <p className="max-w-lg text-sm text-muted-foreground" data-selectable>
        {rec.error ?? 'Unknown error.'}
      </p>
      <p className="text-xs text-muted-foreground">The raw recording was kept, so nothing is lost.</p>
      <Button onClick={() => void retryProcessing(rec)}>
        <RotateCcw /> Retry processing
      </Button>
    </Card>
  );
}

function Editor({ rec }: { rec: RecordingSummary }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [durationMs, setDurationMs] = useState(rec.durationMs ?? 0);
  const [range, setRange] = useState({ startMs: 0, endMs: rec.durationMs ?? 0 });
  const [currentMs, setCurrentMs] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [mode, setMode] = useState<'accurate' | 'fast'>('accurate');
  const [quality, setQuality] = useState<QualityPreset>(useAppStore.getState().settings?.quality ?? 'high');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const exportJob = useJobsStore((s) => jobForRecording(s.jobs, rec.id, 'export'));
  const exporting = !!exportJob && isActive(exportJob);
  const trimValid = validateTrim(range.startMs, range.endMs, durationMs);
  const full = isFullRange(range.startMs, range.endMs, durationMs);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const ms = v.currentTime * 1000;
      setCurrentMs(ms);
      if (previewing && ms >= range.endMs) {
        v.pause();
        setPreviewing(false);
      }
    };
    const onMeta = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        const d = Math.round(v.duration * 1000);
        setDurationMs((prev) => (prev > 0 ? prev : d));
        setRange((r) => (r.endMs > 0 ? r : { startMs: 0, endMs: d }));
      }
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
    };
  }, [previewing, range.endMs]);

  const seek = (ms: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = ms / 1000;
    setCurrentMs(ms);
  };

  const setTrim = (s: number, e: number) => setRange(clampTrim(s, e, durationMs));

  const preview = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = range.startMs / 1000;
    setPreviewing(true);
    void v.play();
  };

  const runExport = async (destination: 'library' | 'file' | 'replace') => {
    if (!trimValid.ok) return;
    try {
      const job = await bloom.jobs.export({
        recordingId: rec.id,
        startMs: Math.round(range.startMs),
        endMs: Math.round(Math.min(range.endMs, durationMs)),
        mode,
        quality,
        destination,
        ...(destination === 'replace' ? { confirmReplace: true } : {}),
      });
      if (job) useJobsStore.getState().upsert(job);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="grid grid-cols-[1fr_320px] gap-5">
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-xl bg-black">
          {videoError ? (
            <div className="flex aspect-video flex-col items-center justify-center gap-2 text-sm text-white/80">
              <FileVideo className="size-8" /> {videoError}
            </div>
          ) : (
            <video
              ref={videoRef}
              src={rec.mediaUrl!}
              controls
              preload="metadata"
              className="aspect-video w-full"
              onError={() => setVideoError('This video could not be played.')}
              data-testid="player-video"
            />
          )}
        </div>
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Scissors className="size-4 text-muted-foreground" /> Trim
            </h2>
            <div className="flex items-center gap-2 text-xs tabular-nums">
              <span className="text-muted-foreground">
                {formatDuration(range.startMs, true)} – {formatDuration(range.endMs, true)}
              </span>
              <Badge tone="primary" data-testid="selection-duration">
                {formatDuration(range.endMs - range.startMs, true)} selected
              </Badge>
            </div>
          </div>
          <TrimTimeline durationMs={durationMs} startMs={range.startMs} endMs={range.endMs} currentMs={currentMs} onChange={setTrim} onSeek={seek} disabled={durationMs <= 0} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setTrim(currentMs, range.endMs)}>
              Set start at playhead
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTrim(range.startMs, currentMs)}>
              Set end at playhead
            </Button>
            <Button size="sm" variant="ghost" disabled={full} onClick={() => setRange({ startMs: 0, endMs: durationMs })}>
              Reset
            </Button>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={preview} disabled={!trimValid.ok}>
              <Play /> Preview selection
            </Button>
          </div>
          {!trimValid.ok && <p className="mt-2 text-xs text-destructive">{trimValid.error}</p>}
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Export</CardTitle>
          <p className="text-xs text-muted-foreground">MP4 (H.264 + AAC). Your original is kept unless you choose to replace it.</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Cut precision</Label>
            <Segmented
              ariaLabel="Cut precision"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'accurate', label: 'Frame-accurate' },
                { value: 'fast', label: 'Fast copy' },
              ]}
            />
            <p className="text-[11px] text-muted-foreground">
              {mode === 'accurate' ? 'Re-encodes for exact cut points.' : 'No re-encoding; cuts snap to the nearest keyframe (up to ~2s).'}
            </p>
          </div>
          {mode === 'accurate' && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Quality</Label>
              <Select<QualityPreset>
                ariaLabel="Export quality"
                value={quality}
                onValueChange={setQuality}
                options={[
                  { value: 'high', label: 'High' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'low', label: 'Small file' },
                ]}
              />
            </div>
          )}

          {exportJob && (exporting || exportJob.status === 'failed' || exportJob.status === 'cancelled') && (
            <div className="rounded-lg border p-3 text-xs" data-testid="export-status">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate font-medium">{exportJob.label}</span>
                {exporting ? (
                  <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => void bloom.jobs.cancel(exportJob.id)}>
                    <X /> Cancel
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2"
                    onClick={() =>
                      bloom.jobs
                        .retry(exportJob.id)
                        .then((j) => useJobsStore.getState().upsert(j))
                        .catch((err) => toast.error(errorMessage(err)))
                    }
                  >
                    <RotateCcw /> Retry
                  </Button>
                )}
              </div>
              {exporting ? (
                <Progress value={(exportJob.progress ?? 0) * 100} indeterminate={exportJob.progress === null || exportJob.status === 'queued'} />
              ) : (
                <p className={exportJob.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'} data-selectable>
                  {exportJob.status === 'failed' ? exportJob.error : 'Export cancelled.'}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Button disabled={!trimValid.ok || exporting} onClick={() => void runExport('library')} data-testid="export-library">
              <Scissors /> {full ? 'Save a copy to library' : 'Save trimmed copy to library'}
            </Button>
            <Button variant="outline" disabled={!trimValid.ok || exporting} onClick={() => void runExport('file')}>
              <Download /> Export as…
            </Button>
            <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={!trimValid.ok || exporting || full} onClick={() => setConfirmReplace(true)}>
              <Replace /> Replace original…
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        title="Replace the original recording?"
        description={`The original file will be overwritten with the trimmed ${formatDuration(range.endMs - range.startMs)} selection. This cannot be undone.`}
        confirmLabel="Replace original"
        destructive
        onConfirm={() => void runExport('replace')}
      />
    </div>
  );
}
