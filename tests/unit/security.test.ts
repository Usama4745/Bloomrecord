import { describe, expect, it } from 'vitest';
import { buildCsp, createTrustedOrigins } from '../../electron/security/origins';
import { formatZodError, toIpcError } from '../../electron/ipc/handle-errors';
import { BloomError } from '@shared/ipc-contracts';
import { InvalidTransitionError } from '@shared/recording-state';
import { MediaError } from '../../electron/media/errors';
import { DiskFullError } from '../../electron/recording/track-writer';
import { z } from 'zod';

describe('trusted origins', () => {
  it('trusts only the app protocol (and the dev server when set)', () => {
    const prod = createTrustedOrigins(undefined);
    expect(prod.isTrusted('app://bloomrecord/index.html')).toBe(true);
    expect(prod.isTrusted('app://bloomrecord')).toBe(true);
    expect(prod.isTrusted('app://evil/index.html')).toBe(false);
    expect(prod.isTrusted('https://bloomrecord/index.html')).toBe(false);
    expect(prod.isTrusted('http://localhost:5173/')).toBe(false);
    expect(prod.isTrusted('file:///C:/index.html')).toBe(false);
    expect(prod.isTrusted('not a url')).toBe(false);
    expect(prod.isTrusted('')).toBe(false);
    const dev = createTrustedOrigins('http://localhost:5173/');
    expect(dev.isTrusted('http://localhost:5173/src/main.tsx')).toBe(true);
    expect(dev.isTrusted('http://localhost:5174/')).toBe(false);
  });

  it('builds a strict production CSP', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/https?:/);
    expect(buildCsp(true)).toMatch(/script-src 'self' 'unsafe-inline'/);
  });
});

describe('IPC error mapping', () => {
  it('maps known errors to codes without leaking internals', () => {
    expect(toIpcError(new BloomError('CONFLICT', 'busy'))).toEqual({ code: 'CONFLICT', message: 'busy' });
    expect(toIpcError(new InvalidTransitionError('recording', 'resume')).code).toBe('CONFLICT');
    expect(toIpcError(new DiskFullError()).code).toBe('DISK_FULL');
    expect(toIpcError(new MediaError('CANCELLED', 'Cancelled')).code).toBe('CANCELLED');
    expect(toIpcError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code).toBe('DISK_FULL');
    expect(toIpcError(Object.assign(new Error('open C:\\secret'), { code: 'ENOENT' }))).toEqual({ code: 'NOT_FOUND', message: 'A required file was not found.' });
    expect(toIpcError('weird').code).toBe('INTERNAL');
    const zerr = z.object({ a: z.number() }).safeParse({ a: 'x' });
    expect(zerr.success).toBe(false);
    if (!zerr.success) {
      expect(toIpcError(zerr.error).code).toBe('VALIDATION');
      expect(formatZodError(zerr.error)).toMatch(/^a: /);
    }
  });
});
