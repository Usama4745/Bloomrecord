/**
 * scheme://host[:port] of a URL. URL.origin cannot be used: it is the opaque
 * "null" for non-special schemes such as our app:// protocol.
 */
function originKey(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`.toLowerCase();
}

export interface TrustedOrigins {
  /** Origins allowed to load in the main window and call privileged APIs. */
  isTrusted(url: string): boolean;
}

export function createTrustedOrigins(devServerUrl: string | undefined): TrustedOrigins {
  const allowed = new Set<string>(['app://bloomrecord']);
  if (devServerUrl) allowed.add(originKey(devServerUrl));
  return {
    isTrusted(url: string) {
      try {
        return allowed.has(originKey(url));
      } catch {
        return false;
      }
    },
  };
}

export function buildCsp(dev: boolean): string {
  const directives = [
    "default-src 'none'",
    // Vite's React refresh preamble is an inline script in development only.
    // 'wasm-unsafe-eval' permits compiling WebAssembly (local background segmentation) and nothing else.
    dev ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'" : "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob: bloom-media:",
    "media-src 'self' blob: mediastream: bloom-media:",
    dev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}
