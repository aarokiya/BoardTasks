import { app, session, shell } from 'electron';
import { APP_ORIGIN, DEV_SERVER_ORIGIN, EXTERNAL_HOST_ALLOWLIST, originOf } from '@shared/constants';
import { createLogger } from '../logger';

const log = createLogger('security');
const INTERNAL_ORIGINS = new Set([APP_ORIGIN, DEV_SERVER_ORIGIN]);
const EXTERNAL_HOSTS = new Set<string>(EXTERNAL_HOST_ALLOWLIST);

export function isInternalUrl(url: string): boolean {
  return INTERNAL_ORIGINS.has(originOf(url));
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
    log.warn('blocked external url', u.host);
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
}
