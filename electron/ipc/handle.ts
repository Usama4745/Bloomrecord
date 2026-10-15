import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import type { IpcChannel, IpcResult } from '@shared/ipc-contracts';
import type { TrustedOrigins } from '../security/origins';
import { formatZodError, toIpcError } from './handle-errors';

export { formatZodError, toIpcError } from './handle-errors';

export type Handler<I, O> = (input: I, event: IpcMainInvokeEvent) => O | Promise<O>;

export function createRegistrar(origins: TrustedOrigins, log: (msg: string, err?: unknown) => void) {
  return function handle<S extends z.ZodType | null, O>(
    channel: IpcChannel,
    schema: S,
    fn: Handler<S extends z.ZodType ? z.infer<S> : undefined, O>,
  ): void {
    ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<O>> => {
      // Only our own top-level renderer may call privileged APIs.
      const frameUrl = event.senderFrame?.url ?? '';
      if (!origins.isTrusted(frameUrl) || event.senderFrame?.parent) {
        return { ok: false, error: { code: 'PERMISSION', message: 'Untrusted sender' } };
      }
      try {
        let input: unknown = undefined;
        if (schema) {
          const parsed = schema.safeParse(payload);
          if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: formatZodError(parsed.error) } };
          input = parsed.data;
        } else if (payload !== undefined && payload !== null) {
          return { ok: false, error: { code: 'VALIDATION', message: 'This call takes no arguments' } };
        }
        const data = await fn(input as never, event);
        return { ok: true, data };
      } catch (err) {
        const mapped = toIpcError(err);
        if (mapped.code === 'INTERNAL') log(`IPC ${channel} failed`, err);
        return { ok: false, error: mapped };
      }
    });
  };
}
