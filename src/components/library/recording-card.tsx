import { FileVideo, Loader2, TriangleAlert } from 'lucide-react';
import type { RecordingSummary } from '@shared/recording-types';
import { useAppStore } from '@/stores/app-store';
import { jobForRecording, useJobsStore } from '@/stores/jobs-store';
import { cn, formatBytes, formatDate, formatDuration, formatResolution } from '@/lib/utils';
import { Badge, Progress } from '@/components/ui/primitives';
import { RecordingMenu } from './recording-actions';

export function RecordingCard({ rec }: { rec: RecordingSummary }) {
  const navigate = useAppStore((s) => s.navigate);
  const job = useJobsStore((s) => (rec.status === 'processing' ? jobForRecording(s.jobs, rec.id, 'compose') : undefined));

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${rec.title}`}
      onClick={() => navigate({ name: 'player', id: rec.id })}
      onKeyDown={(e) => e.key === 'Enter' && navigate({ name: 'player', id: rec.id })}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="recording-card"
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {rec.thumbnailUrl ? (
          <img src={rec.thumbnailUrl} alt="" className={cn('size-full object-cover', rec.fileMissing && 'opacity-40 grayscale')} draggable={false} />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            {rec.status === 'processing' ? <Loader2 className="size-6 animate-spin" /> : <FileVideo className="size-8 opacity-50" />}
          </div>
        )}
        {rec.durationMs !== null && rec.status === 'ready' && (
          <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
            {formatDuration(rec.durationMs)}
          </span>
        )}
        <div className="absolute top-2 left-2 flex gap-1">
          {rec.status === 'processing' && (
            <Badge tone="primary">
              <Loader2 className="animate-spin" /> Processing
            </Badge>
          )}
          {rec.status === 'failed' && (
            <Badge tone="destructive">
              <TriangleAlert /> Failed
            </Badge>
          )}
          {rec.fileMissing && (
            <Badge tone="warning">
              <TriangleAlert /> File missing
            </Badge>
          )}
          {rec.sourceRecordingId && <Badge>Trimmed</Badge>}
        </div>
        {rec.status === 'processing' && (
          <div className="absolute inset-x-0 bottom-0 p-2">
            <Progress value={(job?.progress ?? 0) * 100} indeterminate={job?.progress === null} />
          </div>
        )}
      </div>
      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium" title={rec.title}>
            {rec.title}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {formatDate(rec.createdAt)}
            {rec.status === 'ready' && (
              <>
                {' · '}
                {formatResolution(rec.width, rec.height)}
                {' · '}
                {formatBytes(rec.fileSize)}
              </>
            )}
            {rec.status === 'failed' && rec.error && <span className="text-destructive"> · {rec.error}</span>}
          </p>
        </div>
        <div className="-mt-1 -mr-1 opacity-70 group-hover:opacity-100">
          <RecordingMenu rec={rec} />
        </div>
      </div>
    </div>
  );
}
