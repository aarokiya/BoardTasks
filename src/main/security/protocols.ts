import { net, protocol } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_HOST, APP_SCHEME, ASSET_SCHEME } from '@shared/constants';

/** Must be called before app.whenReady(). */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function containedPath(root: string, rel: string): string | null {
  const abs = normalize(join(root, rel));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** After ready: serve the built renderer from app://boardtasks/ and cached images from bt-asset://. */
export function installProtocolHandlers(rendererRoot: string, assetRoot: string): void {
  protocol.handle(APP_SCHEME, async (req) => {
    try {
    const url = new URL(req.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const abs = containedPath(rendererRoot, rel);
    if (!abs) return new Response('Forbidden', { status: 403 });
    const target = existsSync(abs) && statSync(abs).isFile() ? abs : join(rendererRoot, 'index.html');
    return await net.fetch(pathToFileURL(target).toString());
    } catch (e) {
      console.error('app:// handler failed for', req.url, 'root=', rendererRoot, e);
      return new Response('Internal error', { status: 500 });
    }
  });

  protocol.handle(ASSET_SCHEME, (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!/^[A-Za-z0-9_\-.]+$/.test(rel)) return new Response('Forbidden', { status: 403 });
    const abs = containedPath(assetRoot, rel);
    if (!abs || !existsSync(abs)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(abs).toString());
  });
}
