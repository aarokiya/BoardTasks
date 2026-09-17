import type { Routes } from '../router';
import { notImplemented } from './_stub';

type SyncRoutes = Pick<Routes, 'sync:now' | 'sync:getState' | 'outbox:list' | 'outbox:retry' | 'outbox:retryAll' | 'outbox:discard'>;

export function syncRoutes(): SyncRoutes {
  return {
    'sync:now': notImplemented('sync:now'),
    'sync:getState': notImplemented('sync:getState'),
    'outbox:list': notImplemented('outbox:list'),
    'outbox:retry': notImplemented('outbox:retry'),
    'outbox:retryAll': notImplemented('outbox:retryAll'),
    'outbox:discard': notImplemented('outbox:discard'),
  };
}
