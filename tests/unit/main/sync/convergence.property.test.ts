import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { ApiError, NetworkError, RateLimitError } from '../../../../src/main/api/errors';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, listParked, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import {
  createTask,
  deleteTasks,
  getAllTasks,
  getTaskRow,
  getTaskRowByRemoteId,
  setStatus,
  updateTask,
} from '../../../../src/main/db/repositories/tasks';
import { asCivil } from '../../../../src/shared/date/civil';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * Property test: random interleavings of local mutations, remote edits,
 * scripted failures and network partitions must always converge, and must
 * never lose a write the user could still see.
 *
 * "No lost writes" is the sharp one. A local edit may legitimately be
 * overwritten by the three-way merge — but only when the server ALSO changed
 * that field, in which case a conflict is recorded. Quietly dropping an edit
 * nobody contested, or holding a task that exists on Google but nowhere
 * locally, is what this hunts for.
 */

/** Tiny deterministic PRNG so a failing seed can be replayed exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_LIST = 'L-default';
const STEP_GAP_MS = 10 * 60_000;
let h: SyncHarness;
let listId = '';

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
  const list = createList({ title: 'Work' });
  bindListRemoteId(list.id, DEFAULT_LIST, '"l"', h.google.serverNowIso());
  for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
  listId = list.id;
});
afterEach(() => {
  closeDatabase();
});

type StepKind =
  | 'localCreate'
  | 'localRename'
  | 'localComplete'
  | 'localDue'
  | 'localDelete'
  | 'remoteEdit'
  | 'remoteInsert'
  | 'remoteDelete'
  | 'partition'
  | 'heal'
  | 'failOnce'
  | 'rateLimit'
  | 'sync';

const STEPS: StepKind[] = [
  'localCreate',
  'localCreate',
  'localRename',
  'localRename',
  'localComplete',
  'localDue',
  'localDelete',
  'remoteEdit',
  'remoteInsert',
  'remoteDelete',
  'partition',
  'heal',
  'failOnce',
  'rateLimit',
  'sync',
  'sync',
  'sync',
];

function pick<T>(rng: () => number, arr: readonly T[]): T | undefined {
  return arr.length === 0 ? undefined : arr[Math.floor(rng() * arr.length)];
}

/** One push+pull cycle, driving the fake clock so in-flight timers fire. */
async function cycle(opts: { full?: boolean } = {}): Promise<boolean> {
  try {
    // `settle` runs the clock while the cycle is in flight: a 429 empties the
    // token bucket and arms a refill timer nothing else would release.
    await h.settle(h.cycle(opts));
    return true;
  } catch (e) {
    // Partitions and scripted failures are the point of the exercise.
    if (!(e instanceof NetworkError || e instanceof ApiError)) throw e;
    return false;
  } finally {
    await h.clock.flush();
  }
}

async function runScenario(seed: number, steps: number): Promise<void> {
  const rng = mulberry32(seed);
  let n = 0;

  for (let i = 0; i < steps; i++) {
    const kind = STEPS[Math.floor(rng() * STEPS.length)]!;
    const locals = getAllTasks().filter((t) => !t.deleted);
    const remotes = h.google.tasks().filter((t) => !t.deleted && t.listId === DEFAULT_LIST);

    switch (kind) {
      case 'localCreate':
        createTask({ title: `local-${seed}-${n++}`, listId, previousId: 'end' });
        break;
      case 'localRename': {
        const t = pick(rng, locals);
        if (t) updateTask({ id: t.id, patch: { title: `renamed-${n++}` } });
        break;
      }
      case 'localComplete': {
        const t = pick(rng, locals);
        if (t) setStatus([t.id], t.status !== 'completed');
        break;
      }
      case 'localDue': {
        const t = pick(rng, locals);
        if (t) updateTask({ id: t.id, patch: { due: asCivil(`2026-10-${String((n++ % 27) + 1).padStart(2, '0')}`) } });
        break;
      }
      case 'localDelete': {
        const t = pick(rng, locals);
        if (t) deleteTasks([t.id]);
        break;
      }
      case 'remoteEdit': {
        const t = pick(rng, remotes);
        if (t) h.google.remoteEdit(t.id, { title: `remote-${n++}` });
        break;
      }
      case 'remoteInsert':
        h.google.remoteInsert(DEFAULT_LIST, { title: `server-${seed}-${n++}` });
        break;
      case 'remoteDelete': {
        const t = pick(rng, remotes);
        if (t) h.google.remoteDelete(t.id);
        break;
      }
      case 'partition':
        h.google.partition();
        break;
      case 'heal':
        h.google.heal();
        break;
      case 'failOnce': {
        const method = pick(rng, ['insertTask', 'patchTask', 'listTasks', 'deleteTask'] as const)!;
        h.google.failNext(method, new ApiError(503, null, true), 1);
        break;
      }
      case 'rateLimit':
        h.google.failNext('listTasks', new RateLimitError(1_000, false, 'rateLimitExceeded'), 1);
        break;
      case 'sync':
        await cycle();
        break;
    }
    // ADVANCE, not set: backoff windows and token-bucket refills are timers.
    await h.clock.advance(STEP_GAP_MS);
  }

  await quiesce();
}

/**
 * Stop injecting faults and sync until nothing is left to do. Leftover
 * scripted failures would otherwise be consumed by the very cycles that are
 * meant to prove convergence.
 */
async function quiesce(): Promise<void> {
  h.google.heal();
  h.google.clearFailures();
  for (let i = 0; i < 15; i++) {
    const ok = await cycle();
    await h.clock.advance(STEP_GAP_MS);
    if (ok && listOutboxRows(['pending', 'blocked']).length === 0) break;
  }
  expect(await cycle({ full: true }), 'the final reconcile must succeed').toBe(true);
  expect(await cycle({ full: true }), 'the confirming reconcile must succeed').toBe(true);
}

describe('sync convergence under random interleavings', () => {
  const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];

  it.each(seeds)('seed %i converges with no silently lost writes', async (seed) => {
    await runScenario(seed, 40);

    const locals = getAllTasks().filter((t) => !t.deleted);
    const remotes = h.google.tasks().filter((t) => !t.deleted && t.listId === DEFAULT_LIST);
    const parked = listParked();
    const queuedFor = (id: string): boolean =>
      listOutboxRows(['pending', 'blocked']).some((r) => r.entity_id === id) || parked.some((r) => r.entity_id === id);

    for (const task of locals) {
      const row = getTaskRow(task.id)!;
      const conflicted = row.conflict_json !== null;

      // 1. A row that never reached Google is still visibly accounted for:
      //    queued or parked. Nothing is ever silently dropped.
      if (row.remote_id === null) {
        expect(queuedFor(task.id), `local-only task "${task.title}" must still be queued or parked`).toBe(true);
        continue;
      }

      const remote = h.google.tasks().find((t) => t.id === row.remote_id);

      // 2. A row bound to a remote that is gone must be surfaced as a conflict
      //    (we kept a local edit), never left quietly diverged.
      if (!remote || remote.deleted) {
        expect(conflicted || queuedFor(task.id), `orphaned task "${task.title}" must be surfaced`).toBe(true);
        continue;
      }

      // 3. Settled rows agree with the server, field by field.
      if (!queuedFor(task.id) && !conflicted) {
        expect(row.title, `title diverged for "${task.title}"`).toBe(remote.title);
        expect(row.status, `status diverged for "${task.title}"`).toBe(remote.status);
        expect(row.due ?? null, `due diverged for "${task.title}"`).toBe(remote.due ? remote.due.slice(0, 10) : null);
        expect(row.dirty_fields, 'a settled row carries no dirty fields').toBe('[]');
      }
    }

    // 4. Every live remote task exists locally. The row may be soft-deleted
    //    (the user deleted it and the delete has not flushed), which is why
    //    this looks at rows rather than the visible task list.
    for (const remote of remotes) {
      const row = getTaskRowByRemoteId(remote.id);
      expect(row, `remote "${remote.title}" exists on Google but nowhere locally`).not.toBeNull();
      if (row!.deleted === 1) {
        expect(queuedFor(row!.id), `soft-deleted "${remote.title}" must still have its delete queued`).toBe(true);
      }
    }

    // 5. Once the queue is empty nothing is left unbound — no duplicates and
    //    no stragglers from the non-idempotent insert.
    if (listOutboxRows(['pending', 'blocked']).length === 0 && parked.length === 0) {
      const unbound = getAllTasks().filter((t) => getTaskRow(t.id)!.remote_id === null);
      expect(unbound.map((t) => t.title), 'nothing should be unsynced once the queue is empty').toEqual([]);
    }

    // 6. Local ids are stable: the store never renamed a primary key.
    const ids = getAllTasks().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a second quiet cycle changes nothing (the merge is a fixed point)', async () => {
    await runScenario(4242, 30);
    const snapshot = (): string[] =>
      getAllTasks()
        .map((t) => `${t.id}|${t.title}|${t.status}|${t.due ?? ''}|${t.sortKey}`)
        .sort();

    const before = snapshot();
    await cycle();
    await cycle();
    expect(snapshot()).toEqual(before);
  });

  it('an offline burst survives a long partition and flushes completely', async () => {
    h.google.partition();
    const created = Array.from({ length: 25 }, (_, i) => createTask({ title: `offline-${i}`, listId, previousId: 'end' }));

    for (let i = 0; i < 5; i++) {
      expect(await cycle()).toBe(false);
      await h.clock.advance(STEP_GAP_MS);
    }
    // Not one of them reached the server, and not one of them was lost.
    expect(h.google.tasks()).toHaveLength(0);
    expect(getAllTasks()).toHaveLength(25);
    expect(listOutboxRows(['pending', 'blocked'])).toHaveLength(25);

    await quiesce();

    expect(listOutboxRows(['pending', 'blocked'])).toHaveLength(0);
    expect(listParked()).toHaveLength(0);
    expect(h.google.tasks().filter((t) => !t.deleted)).toHaveLength(25);
    expect(created.every((t) => getTaskRow(t.id)!.remote_id !== null)).toBe(true);
    // ...and in the order the user made them.
    const order = h.google
      .tasks()
      .slice()
      .sort((a, b) => (a.position < b.position ? -1 : 1))
      .map((t) => t.title);
    expect(order).toEqual(created.map((t) => t.title));
  });
});
