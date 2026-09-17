import type { IpcMainInvokeEvent } from 'electron';
import { APP_ORIGIN, DEV_SERVER_ORIGIN, originOf } from '@shared/constants';

const ALLOWED = new Set([APP_ORIGIN, DEV_SERVER_ORIGIN]);

/** Never trust the renderer, including its identity: top frame only, known origin only. */
export function isTrustedSender(ev: IpcMainInvokeEvent): boolean {
  const frame = ev.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return ALLOWED.has(originOf(frame.url));
}
