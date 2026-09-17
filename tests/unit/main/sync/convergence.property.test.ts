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
import { createTask, deleteTasks, getAllTasks, getTaskRow, setStatus, updateTask } from '../../../../src/main/db/repositories/tasks';
import { asCivil } from '../../../../src/shared/date/civil';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';
import type { FakeTaskRow } from '../../../fakes/fake-google-api';

/**
 * Property test: random interleavings of local mutations, remote edits,
 * failures and partitions must always converge, and must never lose a write
 * the user could still see.
 *
 * "No lost writes" is the sharp one. A local edit may legitimately be
 * overwritten by the three-way merge — but only when the server ALSO changed
 * that field, in which case a conflict must be recorded. Silently dropping an
 * edit nobody contested is the bug this hunts for.
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

type Step =
  | { kind: 'localCreate' }
  | { kind: 'localRename' }
  | { kind: 'localComplete' }
  | { kind: 'localDue' }
  | { kind: 'localDelete' }
  | { kind: 'remoteEdit' }
  | { kind: 'remoteInsert' }
  | { kind: 'remoteDelete' }
  | { kind: 'partition' }
  | { kind: 'heal' }
  | { kind: 'failOnce' }
  | { kind: 'rateLimit' }
  | { kind: 'sync' };

const STEPS: Step['kind'][] = [
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
        if (process.env['BT_TRACE']) console.error('> step', i);
        await step();
        if (process.env['BT_TRACE']) console.error('< step', i);
        break;
    }
    // ADVANCE, not set: a 429 empties the token bucket and arms a refill
    // timer, which only a clock that actually fires timers will release.
    await h.clock.advance(10 * 60_000);
  }

  // Quiesce: heal everything and sync until the system stops changing.
  h.google.heal();
  for (let i = 0; i < 12; i++) {
    if (process.env['BT_TRACE']) console.error('> quiesce', i, 'outbox', listOutboxRows(['pending', 'blocked']).length, 'queue', JSON.stringify(h.queue.stats()));
    await step();
    await h.clock.advance(10 * 60_000);
    if (listOutboxRows(['pending', 'blocked']).length === 0) break;
  }
  if (process.env['BT_TRACE']) console.error('> final full 1');
  await step({ full: true });
  if (process.env['BT_TRACE']) console.error('> final full 2');
  await step({ full: true });
  if (process.env['BT_TRACE']) console.error('> done');
}

async function step(opts: { full?: boolean } = {}): Promise<void> {
  try {
    if (process.env['BT_TRACE']) console.error('  push start');
    await h.push();
    if (process.env['BT_TRACE']) console.error('  push done; pull start');
    if (process.env['BT_TRACE']) {
      const before = h.google.calls().length;
      const timer = setInterval(() => {
        const recent = h.google.calls().slice(-4).map((c) => `${c.method}(${JSON.stringify(c.args[0]).slice(0, 60)})`);
        console.error('  pull STILL RUNNING; calls', h.google.calls().length - before, recent.join(' | '));
      }, 400);
      try {
        await h.pull(opts);
      } finally {
        clearInterval(timer);
      }
    } else {
      await h.pull(opts);
    }
    if (process.env['BT_TRACE']) console.error('  pull done');
  } catch (e) {
    // Partitions and scripted 503s are expected; the point is what survives.
    if (!(e instanceof NetworkError || e instanceof ApiError)) throw e;
  }
  await h.clock.flush();
}

function remoteById(id: string): FakeTaskRow | undefined {
  return h.google.tasks().find((t) => t.id === id);
}

describe('sync convergence under random interleavings', () => {
  const seeds = process.env['BT_TRACE'] ? [21] : [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];

  it.each(seeds)('seed %i converges with no silently lost writes', async (seed) => {
    await runScenario(seed, 40);

    const locals = getAllTasks().filter((t) => !t.deleted);
    const remotes = h.google.tasks().filter((t) => !t.deleted && t.listId === DEFAULT_LIST);
    const parked = listParked();

    for (const task of locals) {
      const row = getTaskRow(task.id)!;

      // 1. Anything still unsynced is visibly accounted for: queued, parked or
      //    flagged as a conflict. Nothing is ever silently dropped.
      const queued = listOutboxRows(['pending', 'blocked']).some((r) => r.entity_id === task.id);
      const isParked = parked.some((r) => r.entity_id === task.id);
      const conflicted = row.conflict_json !== null;

      if (row.remote_id === null) {
        expect(queued || isParked, `local-only task ${task.title} must still be queued or parked`).toBe(true);
        continue;
      }

      const remote = remoteById(row.remote_id);

      // 2. A row bound to a remote id whose remote is gone must be a conflict
      //    (we kept a local edit) — never a silent divergence.
      if (!remote || remote.deleted) {
        expect(conflicted || queued || isParked, `orphaned task ${task.title} must be surfaced`).toBe(true);
        continue;
      }

      // 3. Fully settled rows agree with the server, field by field.
      if (!queued && !isParked && !conflicted) {
        expect(row.title, `title diverged for ${task.id}`).toBe(remote.title);
        expect(row.status, `status diverged for ${task.id}`).toBe(remote.status);
        expect(row.due ?? null, `due diverged for ${task.id}`).toBe(remote.due ? remote.due.slice(0, 10) : null);
        expect(row.dirty_fields, `settled rows carry no dirty fields`).toBe('[]');
      }
    }

    // 4. Every live remote task is represented locally exactly once — no
    //    duplicates from a non-idempotent insert, no missing rows.
    for (const remote of remotes) {
      const matches = getAllTasks().filter((t) => getTaskRow(t.id)!.remote_id === remote.id);
      expect(matches.length, `remote ${remote.title} should map to exactly one local row`).toBe(1);
    }

    // 5. Local ids are stable: the store never renamed a primary key.
    const ids = getAllTasks().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a second quiet cycle changes nothing (the merge is a fixed point)', async () => {
    await runScenario(4242, 30);
    const before = getAllTasks()
      .map((t) => `${t.id}|${t.title}|${t.status}|${t.due ?? ''}|${t.sortKey}`)
      .sort();

    await step();
    await step();

    const after = getAllTasks()
      .map((t) => `${t.id}|${t.title}|${t.status}|${t.due ?? ''}|${t.sortKey}`)
      .sort();
    expect(after).toEqual(before);
  });

  it('an offline burst survives a long partition and flushes completely', async () => {
    h.google.partition();
    const created = [];
    for (let i = 0; i < 25; i++) created.push(createTask({ title: `offline-${i}`, listId, previousId: 'end' }));
    for (let i = 0; i < 5; i++) {
      await step();
      await h.clock.advance(10 * 60_000);
    }
    // Not one of them reached the server, and not one of them was lost.
    expect(h.google.tasks()).toHaveLength(0);
    expect(getAllTasks()).toHaveLength(25);

    h.google.heal();
    for (let i = 0; i < 6; i++) {
      await step();
      await h.clock.advance(10 * 60_000);
      if (listOutboxRows(['pending', 'blocked']).length === 0) break;
    }

    expect(listOutboxRows(['pending', 'blocked'])).toHaveLength(0);
    expect(listParked()).toHaveLength(0);
    expect(h.google.tasks().filter((t) => !t.deleted)).toHaveLength(25);
    expect(created.every((t) => getTaskRow(t.id)!.remote_id !== null)).toBe(true);
  });
});
