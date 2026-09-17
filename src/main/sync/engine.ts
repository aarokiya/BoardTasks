import type { MainEvent } from '@shared/events';
import type { AuthState, SyncState, SyncStatusKind, TaskList } from '@shared/models';
import type { Logger } from '../logger';
import type { GoogleTasksApi } from '../api/google-tasks';
import { createRequestQueue, type RequestQueue } from '../api/request-queue';
import type { TokenProvider } from '../auth/types';
import { getAllLists, getListRow, hardDeleteList, restoreListRow } from '../db/repositories/lists';
import {
  counts,
  getOutboxRow,
  listParked,
  recoverInflight,
  updateOutbox,
  vacuumDone,
} from '../db/repositories/outbox';
import { countConflicts, getTaskRow, getTasks, hardDeleteTask, rawUpdate } from '../db/repositories/tasks';
import { classifyError } from './backoff';
import { syncHooks } from './hooks';
import type { Clock, Random } from './clock';
import { isoAt } from './clock';
import { parseBase } from './merge';
import type { NetworkMonitor } from './network-monitor';
import { runPull, type PullDeps } from './pull';
import { runPush, type PushDeps } from './push';
import { createScheduler, type Scheduler, type SchedulerIntervals, type SyncTrigger } from './scheduler';

/**
 * Ties the pieces together: scheduler → (push, then pull) → state + events.
 *
 * Push first: the user's own changes should reach Google before we merge
 * anything from it, so a local edit is never overwritten by the stale copy the
 * server still has.
 */

export interface SyncEngineDeps {
  api: GoogleTasksApi;
  tokens: TokenProvider;
  clock: Clock;
  random: Random;
  network: NetworkMonitor;
  logger: Logger;
  emit(event: MainEvent): void;
  queue?: RequestQueue;
  isFocused?: () => boolean;
  isOnBattery?: () => boolean;
  intervals?: Partial<SchedulerIntervals>;
}

export interface SyncEngine {
  start(): void;
  stop(): void;
  syncNow(opts?: { full?: boolean }): Promise<SyncState>;
  getState(): SyncState;
  onState(cb: (s: SyncState) => void): () => void;
  localEdit(): void;
  setFocused(focused: boolean): void;
  retryOutbox(id: string): void;
  retryAllOutbox(): void;
  discardOutbox(id: string): void;
}

export function initialSyncState(online: boolean): SyncState {
  return {
    status: online ? 'idle' : 'offline',
    online,
    lastSyncStartedAt: null,
    lastSyncSucceededAt: null,
    pendingCount: 0,
    failedCount: 0,
    conflictCount: 0,
    errorMessage: null,
    retryAfterMs: null,
  };
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { clock, logger, network, tokens, emit } = deps;
  const queue = deps.queue ?? createRequestQueue({ clock, logger });
  const listeners = new Set<(s: SyncState) => void>();

  let state = initialSyncState(network.isOnline());
  let started = false;
  let running = false;
  let rateLimitedUntil: number | null = null;
  let lastErrorMessage: string | null = null;
  let unsubs: Array<() => void> = [];

  function authState(): AuthState {
    try {
      return tokens.getStatus().state;
    } catch {
      return 'signed_out';
    }
  }

  function computeStatus(): SyncStatusKind {
    const auth = authState();
    if (auth === 'reauth_required') return 'reauth_required';
    if (auth !== 'signed_in') return 'paused';
    const net = network.status();
    if (net === 'captive_portal') return 'captive_portal';
    if (running) return 'syncing';
    if (net === 'offline') return 'offline';
    if (rateLimitedUntil !== null && rateLimitedUntil > clock.now()) return 'rate_limited';
    if (lastErrorMessage !== null) return 'error';
    return 'idle';
  }

  function publish(): void {
    const c = counts();
    const next: SyncState = {
      ...state,
      status: computeStatus(),
      online: network.isOnline(),
      pendingCount: c.pending,
      failedCount: c.parked,
      conflictCount: countConflicts(),
      errorMessage: lastErrorMessage,
      retryAfterMs: rateLimitedUntil !== null ? Math.max(0, rateLimitedUntil - clock.now()) : null,
    };
    if (sameState(state, next)) {
      state = next;
      return;
    }
    state = next;
    emit({ type: 'sync:state', state: next });
    for (const cb of [...listeners]) cb(next);
  }

  function observe(error: unknown | null): void {
    queue.noteOutcome(error);
    if (error === null) network.noteSuccess();
    else network.noteFailure(error);
  }

  function emitChanges(
    taskIds: Iterable<string>,
    deletedTaskIds: Iterable<string>,
    listIds: Iterable<string>,
    deletedListIds: Iterable<string>,
    reason: 'sync' | 'conflict',
  ): void {
    const ids = [...taskIds];
    const deletedTasks = [...deletedTaskIds];
    const lists = [...listIds];
    const deletedLists = [...deletedListIds];
    if (ids.length === 0 && deletedTasks.length === 0 && lists.length === 0 && deletedLists.length === 0) return;
    const all = getAllLists();
    const listSet = new Set(lists);
    emit({
      type: 'data:changed',
      reason,
      tasks: getTasks(ids),
      lists: all.filter((l: TaskList) => listSet.has(l.id)),
      deletedTaskIds: deletedTasks,
      deletedListIds: deletedLists,
    });
  }

  async function runCycle(opts: { full: boolean; trigger: SyncTrigger }): Promise<void> {
    running = true;
    state = { ...state, lastSyncStartedAt: clock.nowIso() };
    publish();

    const now = isoAt(clock.now());
    const io = { api: deps.api, clock, logger, queue, observe };
    const pushDeps: PushDeps = { ...io, random: deps.random };
    const pullDeps: PullDeps = { ...io, priority: opts.trigger === 'manual' ? 0 : 2 };

    const touched = new Set<string>();
    const deletedTasks = new Set<string>();
    const conflicts = new Set<string>();
    const listsTouched = new Set<string>();
    const deletedLists = new Set<string>();

    try {
      const push = await runPush(pushDeps);
      for (const id of push.changes.touched) touched.add(id);
      for (const id of push.listsTouched) listsTouched.add(id);
      if (push.retryAfterMs !== null) rateLimitedUntil = clock.now() + push.retryAfterMs;
      if (push.authError !== null) throw push.authError;

      const pull = await runPull(pullDeps, now, { full: opts.full, coldStart: opts.trigger === 'startup' });
      for (const id of pull.changes.touched) touched.add(id);
      for (const id of pull.changes.deleted) {
        deletedTasks.add(id);
        touched.delete(id);
      }
      for (const id of pull.changes.conflicts) conflicts.add(id);
      for (const id of pull.listsTouched) listsTouched.add(id);
      for (const id of pull.listsDeleted) deletedLists.add(id);

      lastErrorMessage = null;
      if (rateLimitedUntil !== null && rateLimitedUntil <= clock.now()) rateLimitedUntil = null;
      state = { ...state, lastSyncSucceededAt: clock.nowIso() };
      vacuumDone();
    } catch (e) {
      const c = classifyError(e);
      lastErrorMessage = c.message;
      if (c.disposition === 'rate_limited' && c.retryAfterMs !== null) rateLimitedUntil = clock.now() + c.retryAfterMs;
      if (c.disposition === 'auth') {
        // Deliberately NOT re-triggering here: retrying a dead grant in a loop
        // burns quota. The auth track flips its status and `onStatusChanged`
        // resumes us; until then the ordinary poll interval applies.
        logger.warn('sync paused: authentication needed');
      } else {
        logger.warn(`sync cycle failed: ${c.message}`);
      }
    } finally {
      running = false;
      // Emit whatever landed, even on a partial failure — the merge is
      // idempotent, so a half-finished pull still leaves the store correct.
      emitChanges(touched, deletedTasks, listsTouched, deletedLists, conflicts.size > 0 ? 'conflict' : 'sync');
      // The tray badge, dock count and reminder scheduler chain onto this hook
      // rather than listening to data:changed, so a cycle that moved tasks
      // must ring it explicitly.
      if (touched.size > 0 || deletedTasks.size > 0) syncHooks.onTasksChanged();
      publish();
    }
  }

  const scheduler: Scheduler = createScheduler({
    clock,
    logger,
    runCycle,
    isOnline: () => network.isOnline(),
    authState,
    isOnBattery: deps.isOnBattery ?? (() => false),
    isFocused: deps.isFocused ?? (() => true),
    intervals: deps.intervals,
  });

  return {
    start() {
      if (started) return;
      started = true;
      // A crash can leave rows marked inflight; nothing is actually in flight.
      const recovered = recoverInflight();
      if (recovered > 0) logger.info(`recovered ${recovered} in-flight outbox entries`);

      unsubs.push(
        network.on('change', (s) => {
          scheduler.networkChanged(s === 'online');
          publish();
        }),
      );
      unsubs.push(
        tokens.onStatusChanged((status) => {
          scheduler.authChanged(status.state);
          publish();
        }),
      );
      network.start();
      scheduler.start();
      publish();
    },

    stop() {
      if (!started) return;
      started = false;
      scheduler.stop();
      network.stop();
      queue.drainAndStop();
      for (const u of unsubs) u();
      unsubs = [];
      publish();
    },

    async syncNow(opts) {
      if (!started || authState() !== 'signed_in') {
        publish();
        return state;
      }
      await scheduler.manual(opts?.full ?? false);
      return state;
    },

    getState: () => state,

    onState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    localEdit: () => scheduler.localEdit(),
    setFocused: (f) => scheduler.setFocused(f),

    retryOutbox(id) {
      const row = getOutboxRow(id);
      if (!row || row.status === 'done') return;
      updateOutbox(id, {
        status: 'pending',
        attempts: 0,
        blocked_passes: 0,
        next_attempt_at: isoAt(clock.now()),
        last_error: null,
        last_error_code: null,
      });
      publish();
      scheduler.localEdit();
    },

    retryAllOutbox() {
      const now = isoAt(clock.now());
      for (const row of listParked()) {
        updateOutbox(row.id, { status: 'pending', attempts: 0, blocked_passes: 0, next_attempt_at: now, last_error: null, last_error_code: null });
      }
      publish();
      scheduler.localEdit();
    },

    discardOutbox(id) {
      const row = getOutboxRow(id);
      if (!row || row.status === 'done') return;
      updateOutbox(id, { status: 'done', last_error: null, last_error_code: null });
      const now = isoAt(clock.now());
      const touched = new Set<string>();
      const deletedTasks = new Set<string>();
      const listsTouched = new Set<string>();
      const deletedLists = new Set<string>();

      if (row.entity === 'task' || row.op === 'task.clear') {
        const task = getTaskRow(row.entity_id);
        if (row.op === 'task.create') {
          if (task && task.remote_id === null) {
            hardDeleteTask(task.id);
            deletedTasks.add(task.id);
          }
        } else if (row.op === 'task.delete') {
          if (task) {
            rawUpdate(task.id, { deleted: 0, local_updated_at: now });
            touched.add(task.id);
          }
        } else if (task) {
          // Revert the optimistic edit to the last state the server confirmed.
          const base = parseBase(task);
          if (base) {
            rawUpdate(task.id, {
              title: base.title,
              notes: base.notes,
              status: base.status,
              due: base.due,
              completed_at: base.completedAt,
              dirty_fields: '[]',
              conflict_json: null,
              local_updated_at: now,
            });
          } else {
            rawUpdate(task.id, { dirty_fields: '[]', conflict_json: null, local_updated_at: now });
          }
          touched.add(task.id);
        }
      } else {
        const list = getListRow(row.entity_id);
        if (row.op === 'list.create' && list && list.remote_id === null) {
          hardDeleteList(list.id);
          deletedLists.add(list.id);
        } else if (row.op === 'list.delete' && list) {
          restoreListRow(list.id);
          listsTouched.add(list.id);
        } else if (list) {
          listsTouched.add(list.id);
        }
      }

      emitChanges(touched, deletedTasks, listsTouched, deletedLists, 'sync');
      publish();
    },
  };
}

function sameState(a: SyncState, b: SyncState): boolean {
  return (
    a.status === b.status &&
    a.online === b.online &&
    a.lastSyncStartedAt === b.lastSyncStartedAt &&
    a.lastSyncSucceededAt === b.lastSyncSucceededAt &&
    a.pendingCount === b.pendingCount &&
    a.failedCount === b.failedCount &&
    a.conflictCount === b.conflictCount &&
    a.errorMessage === b.errorMessage &&
    a.retryAfterMs === b.retryAfterMs
  );
}
