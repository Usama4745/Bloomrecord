import { useState } from 'react';
import { Ellipsis, FolderOpen, Pencil, Play, RotateCcw, Trash2 } from 'lucide-react';
import type { RecordingSummary } from '@shared/recording-types';
import { titleSchema } from '@shared/validation';
import { bloom, errorMessage } from '@/services/bloom';
import { useAppStore } from '@/stores/app-store';
import { toast } from '@/stores/toast-store';
import { Button } from '@/components/ui/button';
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays';
import { Input, Label, Switch } from '@/components/ui/primitives';

export async function retryProcessing(rec: RecordingSummary): Promise<void> {
  if (!rec.sessionId) {
    toast.error('The raw recording for this item is no longer available.');
    return;
  }
  try {
    await bloom.recording.recover(rec.sessionId);
    toast.info(`Processing “${rec.title}” again…`);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function RenameDialog({ rec, open, onOpenChange }: { rec: RecordingSummary; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [title, setTitle] = useState(rec.title);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const parsed = titleSchema.safeParse(title);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid title');
      return;
    }
    setSaving(true);
    try {
      await bloom.library.rename(rec.id, parsed.data);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o && (setTitle(rec.title), setError(null)), onOpenChange(o))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename recording</DialogTitle>
          <DialogDescription>The title is shown in your library. The file on disk keeps its name.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Label htmlFor="rename-title">Title</Label>
          <Input id="rename-title" autoFocus value={title} maxLength={200} onChange={(e) => (setTitle(e.target.value), setError(null))} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDialog({
  rec,
  open,
  onOpenChange,
  onDeleted,
}: {
  rec: RecordingSummary;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDeleted?: () => void;
}) {
  const [deleteFile, setDeleteFile] = useState(!rec.fileMissing);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete “${rec.title}”?`}
      description={
        rec.fileMissing
          ? 'The video file is already missing. This removes the entry from your library.'
          : 'This removes the recording from your library.'
      }
      confirmLabel="Delete"
      destructive
      onConfirm={async () => {
        try {
          await bloom.library.delete(rec.id, deleteFile && !rec.fileMissing);
          toast.success(deleteFile && !rec.fileMissing ? 'Recording moved to the trash.' : 'Removed from library.');
          onDeleted?.();
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      {!rec.fileMissing && (
        <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
          <span>
            <span className="font-medium">Also delete the video file</span>
            <span className="block text-xs text-muted-foreground">Moves {rec.fileName} to the system trash.</span>
          </span>
          <Switch checked={deleteFile} onCheckedChange={setDeleteFile} aria-label="Also delete the video file" />
        </label>
      )}
    </ConfirmDialog>
  );
}

/** Kebab menu with rename / reveal / delete (and retry for failed items). */
export function RecordingMenu({ rec, onDeleted }: { rec: RecordingSummary; onDeleted?: () => void }) {
  const navigate = useAppStore((s) => s.navigate);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${rec.title}`} onClick={(e) => e.stopPropagation()}>
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {rec.status === 'ready' && !rec.fileMissing && (
            <DropdownMenuItem onSelect={() => navigate({ name: 'player', id: rec.id })}>
              <Play /> Open & trim
            </DropdownMenuItem>
          )}
          {rec.status === 'failed' && (
            <DropdownMenuItem onSelect={() => void retryProcessing(rec)}>
              <RotateCcw /> Retry processing
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={rec.fileMissing || rec.status !== 'ready'}
            onSelect={() => bloom.library.reveal(rec.id).catch((err) => toast.error(errorMessage(err)))}
          >
            <FolderOpen /> Show in folder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={rec.status === 'processing'} onSelect={() => setDeleting(true)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog rec={rec} open={renaming} onOpenChange={setRenaming} />
      <DeleteDialog rec={rec} open={deleting} onOpenChange={setDeleting} onDeleted={onDeleted} />
    </>
  );
}
