import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { isPathInside } from './path-guard';
import { buildCsp } from './hardening';
import { parseRange } from './range';

export const APP_SCHEME = 'app';
export const APP_HOST = 'bloomrecord';
export const MEDIA_SCHEME = 'bloom-media';

/** Must run before app 'ready'. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Serves the built renderer from disk under app://bloomrecord/, with a strict CSP. */
export function handleAppProtocol(rendererDir: string): void {
  const csp = buildCsp(false);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(rendererDir, rel);
    if (!isPathInside(rendererDir, file)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Streams library media by recording id: bloom-media://recording/<id> and
 * bloom-media://thumbnail/<id>. The renderer never sees or supplies paths;
 * ids are resolved through the database. Supports Range for seeking.
 */
export function handleMediaProtocol(resolve: (kind: string, id: string) => string | null): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const kind = url.host;
    const id = url.pathname.replace(/^\//, '');
    if (!ID_RE.test(id) || (kind !== 'recording' && kind !== 'thumbnail')) return new Response('Bad request', { status: 400 });
    const file = resolve(kind, id);
    if (!file) return new Response('Not found', { status: 404 });
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(stream, { status: range ? 206 : 200, headers });
  });
}
