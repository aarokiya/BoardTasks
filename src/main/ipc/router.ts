import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { CHANNELS, type Channel, type Req, type Res } from '@shared/ipc';
import type { Result } from '@shared/result';
import { toIpcError } from './errors';
import { isTrustedSender } from './sender-guard';

export type Handler<C extends Channel> = (payload: Req<C>, ev: IpcMainInvokeEvent) => Promise<Res<C>> | Res<C>;
export interface Route<C extends Channel> {
  schema: z.ZodType<Req<C>, unknown>;
  handle: Handler<C>;
}
/** Exhaustive: forgetting a channel is a compile error. */
export type Routes = { [C in Channel]: Route<C> };

export function registerRoutes(routes: Routes): void {
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, async (ev, raw: unknown): Promise<Result<unknown>> => {
      const traceId = randomUUID().slice(0, 8);
      try {
        if (!isTrustedSender(ev)) {
          return { ok: false, error: { code: 'FORBIDDEN', message: 'Untrusted sender', retryable: false, traceId } };
        }
        const route = routes[channel] as Route<Channel>;
        const parsed = route.schema.safeParse(raw === null ? undefined : raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return {
            ok: false,
            error: {
              code: 'VALIDATION',
              message: `Invalid request: ${issue?.message ?? 'bad payload'}`,
              retryable: false,
              traceId,
              details: { channel, path: issue?.path.join('.') ?? '' },
            },
          };
        }
        const data = await route.handle(parsed.data, ev);
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: toIpcError(e, traceId, channel) };
      }
    });
  }
}
