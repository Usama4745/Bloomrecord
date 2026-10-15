import { ZodError } from 'zod';
import { BloomError, type IpcErrorCode } from '@shared/ipc-contracts';
import { InvalidTransitionError } from '@shared/recording-state';
import { MediaError } from '../media/errors';
import { DiskFullError } from '../recording/track-writer';

export function formatZodError(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** Maps any thrown value to a safe envelope error. Internal details (stacks, paths in raw errors) stay in main. */
export function toIpcError(err: unknown): { code: IpcErrorCode; message: string } {
  if (err instanceof BloomError) return { code: err.code, message: err.message };
  if (err instanceof ZodError) return { code: 'VALIDATION', message: formatZodError(err) };
  if (err instanceof InvalidTransitionError) return { code: 'CONFLICT', message: err.message };
  if (err instanceof DiskFullError) return { code: 'DISK_FULL', message: err.message };
  if (err instanceof MediaError) {
    const code: IpcErrorCode = err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code === 'IO' ? 'IO' : err.code;
    return { code, message: err.message };
  }
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOSPC') return { code: 'DISK_FULL', message: 'The disk is full.' };
  if (e?.code === 'ENOENT') return { code: 'NOT_FOUND', message: 'A required file was not found.' };
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return { code: 'PERMISSION', message: 'Permission denied.' };
  return { code: 'INTERNAL', message: e?.message ? String(e.message).slice(0, 500) : 'Unexpected error' };
}
