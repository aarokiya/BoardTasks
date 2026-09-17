import type { IpcMainInvokeEvent } from 'electron';
import { isInternalUrl } from '../security/harden';

/**
 * Never trust the renderer, including its identity: top frame only, known
 * origin only.
 *
 * `URL.origin` is the string 'null' for non-special schemes such as app://,
 * so the origin is computed by hand (`originOf`). The allowed set is
 * `internalOrigins()`, which drops the Vite dev origin in a packaged build.
 */
export function isTrustedSender(ev: IpcMainInvokeEvent): boolean {
  const frame = ev.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return isInternalUrl(frame.url);
}
