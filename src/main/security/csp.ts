import { session } from 'electron';
import { ASSET_SCHEME, DEV_SERVER_ORIGIN } from '@shared/constants';

const DEV_WS = DEV_SERVER_ORIGIN.replace('http://', 'ws://');

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

export function installCsp(isPackaged: boolean): void {
  const csp = isPackaged ? PROD_CSP : DEV_CSP;
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    // Only stamp our own documents; never rewrite headers of external requests.
    const isOurs = details.url.startsWith('app://') || details.url.startsWith(DEV_SERVER_ORIGIN);
    if (!isOurs || details.resourceType !== 'mainFrame') return cb({});
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
        'Cross-Origin-Opener-Policy': ['same-origin'],
      },
    });
  });
}
