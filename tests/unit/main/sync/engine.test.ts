import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import type { MainEvent } from '../../../../src/shared/events';
import type { SyncState } from '../../../../src/shared/models';
import { ApiError, NetworkError, RateLimitError } from '../../../../src/main/api/errors';
import { AuthError } from '../../../../src/main/auth/types';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList, getListByRemoteId, getListRow } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, listParked, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, deleteTasks, getAllTasks, getTaskRow, updateTask } from '../../../../src/main/db/repositories/tasks';
import type { SyncEngine } from '../../../../src/main/sync/engine';
import { installSyncHooks, syncHooks } from '../../../../src/main/sync/hooks';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

let h: SyncHarness;
let engine: SyncEngine;
const DEFAULT_LIST = 'L-default';

function states(): SyncState[] {
  return h.events.filter((e): e is Extract<MainEvent, { type: 'sync:state' }> => e.type === 'sync:state').map((e) => e.state);
}
function dataEvents(): Array<Extract<MainEvent, { type: 'data:changed' }>> {
  return h.events.filter((e): e is Extract<MainEvent, { type: 'data:changed' }> => e.type === 'data:changed');
}

/** Bind the default local list to the fake server's seeded list. */
function boundList(title = 'Work'): string {
  const list = createList({ title });
  bindListRemoteId(list.id, DEFAULT_LIST, '"l"', h.google.serverNowIso());
  for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
  return list.id;
}

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
  engine = h.engine();
  installSyncHooks({ onLocalEdit: () => {}, onTasksChanged: () => {} });
});
afterEach(() => {
  engine.stop();
  closeDatabase();
  installSyncHooks({ onLocalEdit: () => {}, onTasksChanged: () => {} });
});

describe('engine lifecycle', () => {
  it('runs push then pull on start and reports success', async () => {
    const listId = boundList();
    createTask({ title: 'Offline task', listId });

    engine.start();
    await h.clock.flush();

    const order = h.google.calls().map((c) => c.method);
    expect(order.indexOf('insertTask')).toBeLessThan(order.indexOf('listTaskLists'));
    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().lastSyncSucceededAt).not.toBeNull();
    expect(engine.getState().pendingCount).toBe(0);
  });

  it('recovers entries a crash left marked inflight', async () => {
    const listId = boundList();
    createTask({ title: 'Was in flight', listId });
    updateOutbox(listOutboxRows()[0]!.id, { status: 'inflight' });

    engine.start();
    await h.clock.flush();
    expect(getTaskRow(getAllTasks()[0]!.id)!.remote_id).not.toBeNull();
  });

  it('stop() is idempotent and leaves no timers armed', async () => {
    engine.start();
    await h.clock.flush();
    engine.stop();
    engine.stop();
    expect(h.clock.pending()).toBe(0);
  });
});

describe('engine state and events', () => {
  it('emits sync:state transitions and only on change', async () => {
    engine.start();
    await h.clock.flush();
    const kinds = states().map((s) => s.status);
    expect(kinds).toContain('syncing');
    expect(kinds.at(-1)).toBe('idle');

    const before = states().length;
    engine.getState();
    expect(states()).toHaveLength(before); // reading state emits nothing
  });

  it('emits data:changed with full task objects for pulled changes', async () => {
    h.google.remoteInsert(DEFAULT_LIST, { title: 'From another device' });
    engine.start();
    await h.clock.flush();

    const ev = dataEvents().at(-1)!;
    expect(ev.reason).toBe('sync');
    expect(ev.tasks.map((t) => t.title)).toContain('From another device');
    expect(ev.tasks[0]!.id).toBeTruthy();
    expect(ev.tasks[0]!.sortKey).toBeTruthy();
  });

  it('reports deletions as ids', async () => {
    const t = h.google.remoteInsert(DEFAULT_LIST, { title: 'ephemeral' });
    engine.start();
    await h.clock.flush();
    const localId = getAllTasks()[0]!.id;

    h.google.remoteDelete(t.id);
    h.events.length = 0;
    await engine.syncNow({ full: true });
    await h.clock.flush();

    expect(dataEvents().at(-1)!.deletedTaskIds).toContain(localId);
    expect(t.id).toBeTruthy();
    expect(localId).toBeTruthy();
  });

  it('uses reason "conflict" when a cycle produced one', async () => {
    const remote = h.google.remoteInsert(DEFAULT_LIST, { title: 'Orig' });
    engine.start();
    await h.clock.flush();
    const localId = getAllTasks()[0]!.id;

    updateTask({ id: localId, patch: { title: 'Mine' } });
    for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' }); // don't push it
    h.google.remoteEdit(remote.id, { title: 'Theirs' });
    h.events.length = 0;

    await engine.syncNow();
    await h.clock.flush();

    expect(dataEvents().at(-1)!.reason).toBe('conflict');
    expect(engine.getState().conflictCount).toBe(1);
  });

  it('rings syncHooks.onTasksChanged so the tray, badge and reminders re-arm', async () => {
    let rang = 0;
    installSyncHooks({ onTasksChanged: () => rang++ });
    h.google.remoteInsert(DEFAULT_LIST, { title: 'new work' });

    engine.start();
    await h.clock.flush();
    expect(rang).toBe(1);

    // A quiet cycle must not ring it.
    await engine.syncNow();
    await h.clock.flush();
    expect(rang).toBe(1);
    expect(syncHooks.onTasksChanged).toBeTypeOf('function');
  });

  it('counts pending, failed and conflicting work in the state', async () => {
    const listId = boundList();
    createTask({ title: 'a', listId });
    createTask({ title: 'b', listId });
    h.google.failNext('insertTask', new ApiError(400, { message: 'nope' }, false), 2);

    engine.start();
    await h.clock.flush();

    expect(engine.getState().failedCount).toBe(2);
    expect(engine.getState().pendingCount).toBe(0);
    expect(listParked()).toHaveLength(2);
  });

  it('onState subscribers see every published state', async () => {
    const seen: SyncState[] = [];
    const off = engine.onState((s) => seen.push(s));
    engine.start();
    await h.clock.flush();
    expect(seen.length).toBeGreaterThan(0);
    off();
    const count = seen.length;
    await engine.syncNow();
    await h.clock.flush();
    expect(seen).toHaveLength(count);
  });
});

describe('engine failure states', () => {
  it('goes offline when the network monitor says so', async () => {
    engine.start();
    await h.clock.flush();
    h.network.set('offline');
    await h.clock.flush();
    expect(engine.getState().status).toBe('offline');
    expect(engine.getState().online).toBe(false);
  });

  it('surfaces a captive portal distinctly from being offline', async () => {
    engine.start();
    await h.clock.flush();
    h.network.set('captive_portal');
    await h.clock.flush();
    expect(engine.getState().status).toBe('captive_portal');
  });

  it('reports rate limiting with the remaining wait', async () => {
    const listId = boundList();
    createTask({ title: 'x', listId });
    h.google.failNext('insertTask', new RateLimitError(90_000, false, 'rateLimitExceeded'), 1);

    engine.start();
    // A 429 empties the token bucket, so the pull that follows waits on a
    // refill timer rather than resolving on microtasks alone.
    await h.clock.advance(10);

    expect(engine.getState().status).toBe('rate_limited');
    // It is a countdown, so it reads slightly below the original wait.
    expect(engine.getState().retryAfterMs).toBeGreaterThan(89_000);
    expect(engine.getState().retryAfterMs).toBeLessThanOrEqual(90_000);
  });

  it('a transient failure becomes an error state with a human-readable message', async () => {
    h.google.failNext('listTaskLists', new NetworkError(new Error('down'), false), 1);
    engine.start();
    await h.clock.flush();
    expect(engine.getState().status).toBe('error');
    expect(engine.getState().errorMessage).toMatch(/Couldn't reach Google/);
  });

  it('clears the error on the next successful cycle', async () => {
    h.google.failNext('listTaskLists', new NetworkError(new Error('down'), false), 1);
    engine.start();
    await h.clock.flush();
    expect(engine.getState().status).toBe('error');

    await engine.syncNow();
    await h.clock.flush();
    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().errorMessage).toBeNull();
  });
});

describe('engine and authentication', () => {
  it('invalid_grant pauses sync, keeps the outbox and resumes after re-auth', async () => {
    const listId = boundList();
    createTask({ title: 'Precious unsynced change', listId });
    h.google.failNext('insertTask', new AuthError('invalid_grant'), 1);

    engine.start();
    await h.clock.flush();

    // The outbox is the whole point of local-first: it must survive.
    expect(listOutboxRows(['pending'])).toHaveLength(1);
    expect(listParked()).toHaveLength(0);

    h.tokens.setState('reauth_required', 'invalid_grant');
    await h.clock.flush();
    expect(engine.getState().status).toBe('reauth_required');

    // Nothing runs while paused.
    h.google.clearCalls();
    await h.clock.advance(10 * 60_000);
    expect(h.google.calls()).toHaveLength(0);

    // Signing back in flushes immediately.
    h.tokens.setState('signed_in');
    await h.clock.flush();
    expect(listOutboxRows(['pending'])).toHaveLength(0);
    expect(getAllTasks()[0]!.remoteId).not.toBeNull();
  });

  it('syncNow while signed out returns the paused state instead of throwing', async () => {
    h.tokens.setState('signed_out');
    engine.start();
    await h.clock.flush();
    const state = await engine.syncNow();
    expect(state.status).toBe('paused');
  });
});

describe('engine outbox controls', () => {
  it('retry resets a parked entry and sends it again', async () => {
    const listId = boundList();
    createTask({ title: 'Eventually fine', listId });
    h.google.failNext('insertTask', new ApiError(400, { message: 'transient server bug' }, false), 1);

    engine.start();
    await h.clock.flush();
    const parked = listParked();
    expect(parked).toHaveLength(1);

    engine.retryOutbox(parked[0]!.id);
    await h.clock.advance(5_000);

    expect(listParked()).toHaveLength(0);
    expect(getAllTasks()[0]!.remoteId).not.toBeNull();
  });

  it('retryAll resets every parked entry', async () => {
    const listId = boundList();
    createTask({ title: 'a', listId });
    createTask({ title: 'b', listId });
    h.google.failNext('insertTask', new ApiError(400, null, false), 2);
    engine.start();
    await h.clock.flush();
    expect(listParked()).toHaveLength(2);

    engine.retryAllOutbox();
    await h.clock.advance(5_000);
    expect(listParked()).toHaveLength(0);
    expect(getAllTasks().every((t) => t.remoteId !== null)).toBe(true);
  });

  it('discarding a never-synced create deletes the optimistic row', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Never going to work', listId });
    h.google.failNext('insertTask', new ApiError(400, null, false), 1);
    engine.start();
    await h.clock.flush();

    const parked = listParked()[0]!;
    h.events.length = 0;
    engine.discardOutbox(parked.id);

    expect(getTaskRow(t.id)).toBeNull();
    expect(dataEvents().at(-1)!.deletedTaskIds).toContain(t.id);
    expect(listParked()).toHaveLength(0);
  });

  it('discarding an update reverts to the last state the server confirmed', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Original', listId });
    engine.start();
    await h.clock.flush();

    updateTask({ id: t.id, patch: { title: 'Bad edit' } });
    h.google.failNext('patchTask', new ApiError(400, null, false), 1);
    await engine.syncNow();
    await h.clock.flush();

    const parked = listParked()[0]!;
    engine.discardOutbox(parked.id);

    const row = getTaskRow(t.id)!;
    expect(row.title).toBe('Original');
    expect(row.dirty_fields).toBe('[]');
    expect(row.conflict_json).toBeNull();
  });

  it('discarding a delete un-deletes the row', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Keep me', listId });
    engine.start();
    await h.clock.flush();

    deleteTasks([t.id]);
    h.google.failNext('deleteTask', new ApiError(400, null, false), 1);
    await engine.syncNow();
    await h.clock.flush();

    engine.discardOutbox(listParked()[0]!.id);
    expect(getTaskRow(t.id)!.deleted).toBe(0);
  });

  it('discarding a never-synced list.create removes the list', async () => {
    const list = createList({ title: 'Doomed' });
    h.google.failNext('insertTaskList', new ApiError(400, null, false), 1);
    engine.start();
    await h.clock.flush();

    engine.discardOutbox(listParked()[0]!.id);
    expect(getListRow(list.id)).toBeNull();
    expect(getListByRemoteId(DEFAULT_LIST)).not.toBeNull(); // the server's list is untouched
  });
});
