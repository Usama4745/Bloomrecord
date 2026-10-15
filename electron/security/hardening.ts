import { app, type Session, type WebContents } from 'electron';
import { buildCsp, type TrustedOrigins } from './origins';

export { buildCsp, createTrustedOrigins, type TrustedOrigins } from './origins';

/** Restricts permissions to camera/mic/screen for our own origin; everything else is denied. */
export function installPermissionHandlers(session: Session, origins: TrustedOrigins): void {
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && origins.isTrusted(details.requestingUrl));
  });
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return allowed.has(permission) && origins.isTrusted(requestingOrigin);
  });
  session.setDevicePermissionHandler(() => false);
}

/** Applies the CSP to dev-server responses (production content is served by the app:// protocol with its own header). */
export function installCspHeaders(session: Session, dev: boolean): void {
  const csp = buildCsp(dev);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
}

/** Blocks navigation away from the app, new windows and webviews for every WebContents. */
export function hardenAllWebContents(origins: TrustedOrigins): void {
  app.on('web-contents-created', (_e, contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!origins.isTrusted(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!origins.isTrusted(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
