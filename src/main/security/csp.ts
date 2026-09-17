import { session } from 'electron';
import { APP_ORIGIN, ASSET_SCHEME, DEV_SERVER_ORIGIN, originOf } from '@shared/constants';

const DEV_WS = DEV_SERVER_ORIGIN.replace('http://', 'ws://');

/**
 * Production policy. `connect-src 'self'` is the load-bearing line: it makes it
 * structurally impossible for renderer code to reach googleapis.com or
 * github.com — over fetch, XHR, WebSocket, EventSource or navigator.sendBeacon,
 * all of which CSP routes through connect-src. `img-src` deliberately excludes
 * https:, so a crafted task title cannot beacon out via an <img> either; remote
 * images (e.g. GitHub avatars) must be cached by main and served from
 * `bt-asset://`. `frame-src`/`child-src`/`object-src` 'none' removes the iframe
 * and plugin escape routes, and `form-action 'none'` the form-post one.
 */
export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${ASSET_SCHEME}:`,
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Dev only. Selected on `app.isPackaged`, so 'unsafe-eval' can never ship. */
export const DEV_CSP = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${DEV_SERVER_ORIGIN}`,
  `style-src 'self' 'unsafe-inline' ${DEV_SERVER_ORIGIN}`,
  `img-src 'self' data: blob: ${ASSET_SCHEME}: ${DEV_SERVER_ORIGIN}`,
  `font-src 'self' data: ${DEV_SERVER_ORIGIN}`,
  `connect-src 'self' ${DEV_SERVER_ORIGIN} ${DEV_WS}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** True for documents and workers we serve ourselves — never for anything else. */
export function isOwnDocumentUrl(url: string, isPackaged: boolean): boolean {
  const origin = originOf(url);
  if (origin === APP_ORIGIN) return true;
  return !isPackaged && origin === DEV_SERVER_ORIGIN;
}

export function installCsp(isPackaged: boolean): void {
  const csp = isPackaged ? PROD_CSP : DEV_CSP;
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    // Only stamp our own responses; never rewrite headers of external requests.
    // Every resource type gets the header, not just `mainFrame`: a dedicated
    // worker takes its CSP from its own response, so stamping documents alone
    // would leave `new Worker('/w.js')` running with no policy at all. Browsers
    // ignore the header on scripts, styles and images, so this is free.
    if (!isOwnDocumentUrl(details.url, isPackaged)) return cb({});
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Referrer-Policy': ['no-referrer'],
      },
    });
  });
}
