import { z } from 'zod';
import type { OutboxEntry, SyncState } from '@shared/models';
import type { Routes } from '../router';
import { idSchema, voidSchema } from '../schemas';
import { listOutbox } from '../../db/repositories/outbox';
import type { SyncEngine } from '../../sync/engine';
import { initialSyncState } from '../../sync/engine';

type SyncRoutes = Pick<Routes, 'sync:now' | 'sync:getState' | 'outbox:list' | 'outbox:retry' | 'outbox:retryAll' | 'outbox:discard'>;

/**
 * The engine is installed by bootstrap once auth and the DB are up. Before
 * that — and whenever the user is signed out — these routes still answer, so
 * the renderer never sees a rejected promise for a status query.
 */
let engine: SyncEngine | null = null;

export function setSyncEngine(next: SyncEngine | null): void {
  engine = next;
}

export function getSyncEngine(): SyncEngine | null {
  return engine;
}

function pausedState(): SyncState {
  return {
    ...initialSyncState(false),
    status: 'paused',
    errorMessage: 'Sign in with Google to start syncing. Your changes are saved on this Mac until then.',
  };
}

export function syncRoutes(): SyncRoutes {
  return {
    'sync:now': {
      schema: z.object({ full: z.boolean().optional() }).optional().or(voidSchema),
      handle: async (p) => {
        if (!engine) return pausedState();
        return engine.syncNow({ full: p?.full ?? false });
      },
    },
    'sync:getState': {
      schema: voidSchema,
      handle: () => engine?.getState() ?? pausedState(),
    },
    'outbox:list': {
      schema: voidSchema,
      handle: (): OutboxEntry[] => listOutbox(),
    },
    'outbox:retry': {
      schema: z.object({ id: idSchema }),
      handle: (p) => {
        engine?.retryOutbox(p.id);
      },
    },
    'outbox:retryAll': {
      schema: voidSchema,
      handle: () => {
        engine?.retryAllOutbox();
      },
    },
    'outbox:discard': {
      schema: z.object({ id: idSchema }),
      handle: (p) => {
        engine?.discardOutbox(p.id);
      },
    },
  };
}
