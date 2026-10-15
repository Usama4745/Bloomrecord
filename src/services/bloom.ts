import { decodeIpcError, type BloomApi, type IpcErrorCode } from '@shared/ipc-contracts';

declare global {
  interface Window {
    bloom: BloomApi;
  }
}

/** The privileged API exposed by the preload script (resolved lazily so tests can install a fake). */
export const bloom: BloomApi = new Proxy({} as BloomApi, {
  get: (_target, key) => (window.bloom as unknown as Record<string | symbol, unknown>)[key],
});

export function errorMessage(err: unknown): string {
  if (err instanceof DOMException) return describeMediaError(err);
  return decodeIpcError(err).message;
}

export function errorCode(err: unknown): IpcErrorCode {
  return decodeIpcError(err).code;
}

/** Human-readable text for getUserMedia/getDisplayMedia failures. */
export function describeMediaError(err: DOMException): string {
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Access was denied. Allow BloomRecord to use this device in your system privacy settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'The selected device was not found. It may have been unplugged.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The device is in use by another application or could not be started.';
    default:
      return err.message || 'The device could not be started.';
  }
}
