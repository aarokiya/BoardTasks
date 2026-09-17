import { app, session, shell } from 'electron';
import { APP_ORIGIN, DEV_SERVER_ORIGIN, EXTERNAL_HOST_ALLOWLIST, originOf } from '@shared/constants';
import { createLogger } from '../logger';

const log = createLogger('security');
const EXTERNAL_HOSTS = new Set<string>(EXTERNAL_HOST_ALLOWLIST);

/**
 * Origins allowed to be a BoardTasks document — i.e. to navigate, to receive
 * the app CSP, and (see sender-guard) to speak IPC.
 *
 * The Vite dev server is an origin any local process can bind. A packaged
 * build must never treat it as ourselves: doing so would let a renderer
 * navigate to http://127.0.0.1:5173 and hand whatever answers there the full
 * privileged IPC surface. Evaluated per call so it cannot be captured before
 * `app.isPackaged` is meaningful, and so tests can flip it.
 */
export function internalOrigins(): readonly string[] {
  return app.isPackaged ? [APP_ORIGIN] : [APP_ORIGIN, DEV_SERVER_ORIGIN];
}

export function isInternalUrl(url: string): boolean {
  const origin = originOf(url);
  return origin !== '' && internalOrigins().includes(origin);
}

/** Opens a URL in the system browser only if it is https and on the allowlist. */
export function openExternalChecked(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || !EXTERNAL_HOSTS.has(u.host)) {
    // Log the scheme+host only; a rejected URL can carry a token in its query.
    log.warn(`blocked external url ${u.protocol}//${u.host}`);
    return false;
  }
  void shell.openExternal(u.toString());
  return true;
}

export function hardenApp(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (!isInternalUrl(url)) {
        e.preventDefault();
        openExternalChecked(url);
      }
    });
    contents.on('will-frame-navigate', (e) => {
      if (!isInternalUrl(e.url)) e.preventDefault();
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openExternalChecked(url);
      return { action: 'deny' };
    });
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'notifications');
  // No HID/serial/USB device should ever be reachable from a task list.
  session.defaultSession.setDevicePermissionHandler(() => false);
}
