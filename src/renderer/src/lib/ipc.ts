import type { Channel, Req, Res } from '@shared/ipc';
import type { IpcError, Result } from '@shared/result';
import type { MainEvent } from '@shared/events';

export class IpcCallError extends Error {
  constructor(readonly error: IpcError) {
    super(error.message);
    this.name = 'IpcCallError';
  }
  get code(): IpcError['code'] {
    return this.error.code;
  }
}

function bridge(): Window['boardtasks'] {
  const b = window.boardtasks;
  if (!b) throw new Error('Preload bridge missing — window.boardtasks is undefined');
  return b;
}

/** Typed invoke that rethrows the envelope as an IpcCallError inside the renderer. */
export async function call<C extends Channel>(channel: C, ...args: Req<C> extends void ? [] : [Req<C>]): Promise<Res<C>> {
  const res = (await bridge().invoke(channel, args[0])) as Result<Res<C>>;
  if (res.ok) return res.data;
  throw new IpcCallError(res.error);
}

/** Non-throwing variant. */
export async function tryCall<C extends Channel>(channel: C, ...args: Req<C> extends void ? [] : [Req<C>]): Promise<Result<Res<C>>> {
  try {
    return (await bridge().invoke(channel, args[0])) as Result<Res<C>>;
  } catch (e) {
    return { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), retryable: false, traceId: 'renderer' } };
  }
}

export const onMainEvent = (cb: (e: MainEvent) => void): (() => void) => bridge().onEvent(cb);
export const boot = (): Window['boardtasks']['boot'] => bridge().boot;
