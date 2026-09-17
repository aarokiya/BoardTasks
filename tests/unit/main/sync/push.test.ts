import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { ApiError, NetworkError, RateLimitError } from '../../../../src/main/api/errors';
import { AuthError } from '../../../../src/main/auth/types';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList, deleteList, getListRow, updateList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, listParked, payloadOf, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import {
  clearCompleted,
  createTask,
  deleteTasks,
  getTaskRow,
  hardDeleteTask,
  moveTask,
  rawUpdate,
  setStatus,
  updateTask,
} from '../../../../src/main/db/repositories/tasks';
import { PARK_AFTER } from '../../../../src/main/sync/backoff';
import { parseInstant } from '../../../../src/main/sync/clock';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';
import { asCivil } from '../../../../src/shared/date/civil';

let h: SyncHarness;

/** The local list that is already bound to the fake server's seeded list. */
function boundList(title = 'Work'): string {
  const list = createList({ title });
  const remote = h.google.lists()[0]!;
  bindListRemoteId(list.id, remote.id, remote.etag, remote.updated);
  for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
  return list.id;
}

function methods(): string[] {
  return h.google.calls().map((c) => c.method);
}

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
});
afterEach(() => {
  closeDatabase();
});

describe('push: happy path', () => {
  it('flushes an offline burst — parent, child, rename and move — in ONE pass, in order', async () => {
    const listId = boundList();
    const parent = createTask({ title: 'Plan trip', listId, previousId: 'end' });
    const child = createTask({ title: 'Book flights', listId, parentId: parent.id, previousId: 'end' });
    const sibling = createTask({ title: 'Pack', listId, previousId: 'end' });
    // A rename while the create is still pending is absorbed into the create.
    updateTask({ id: child.id, patch: { title: 'Book flights to Lisbon' } });
    moveTask({ id: sibling.id, parentId: null, previousId: null });

    h.google.clearCalls();
    const result = await h.push();

    expect(result.pushed).toBe(3);
    expect(result.parked).toBe(0);
    expect(result.blocked).toBe(0);
    expect(methods()).toEqual(['insertTask', 'insertTask', 'insertTask']);

    const calls = h.google.calls();
    // Parent first; the child names the parent's REMOTE id as a query param,
    // because parent is output-only and cannot be set in a body.
    const parentRemote = getTaskRow(parent.id)!.remote_id!;
    expect(calls[1]!.args[2]).toMatchObject({ parent: parentRemote });
    expect(calls[1]!.args[1]).toMatchObject({ title: 'Book flights to Lisbon' });

    expect(getTaskRow(child.id)!.remote_id).not.toBeNull();
    expect(getTaskRow(child.id)!.dirty_fields).toBe('[]');
    expect(listOutboxRows()).toHaveLength(0);
  });

  it('sends due as a date-only instant and completion with a timestamp', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Renew passport', listId, due: asCivil('2026-09-18') });
    await h.push();
    setStatus([t.id], true);
    h.google.clearCalls();
    await h.push();

    const patch = h.google.calls().find((c) => c.method === 'patchTask')!;
    expect(patch.args[2]).toMatchObject({ status: 'completed' });
    expect((patch.args[2] as { completed: string }).completed).toBeTruthy();

    const remote = h.google.task(getTaskRow(t.id)!.remote_id!)!;
    expect(remote.due).toBe('2026-09-18T00:00:00.000Z'); // the 18th, in every timezone
    expect(remote.status).toBe('completed');
  });

  it('reopening sends completed:null, which Google requires to clear it', async () => {
    const listId = boundList();
    const t = createTask({ title: 'x', listId });
    await h.push();
    setStatus([t.id], true);
    await h.push();
    setStatus([t.id], false);
    h.google.clearCalls();
    await h.push();
    const patch = h.google.calls().find((c) => c.method === 'patchTask')!;
    expect(patch.args[2]).toMatchObject({ status: 'needsAction', completed: null });
    expect(h.google.task(getTaskRow(t.id)!.remote_id!)!.completed).toBeNull();
  });

  it('list.create binds the remote id and unblocks the tasks waiting on it', async () => {
    const list = createList({ title: 'Groceries' });
    const t = createTask({ title: 'Milk', listId: list.id });
    const result = await h.push();
    expect(methods()).toEqual(['insertTaskList', 'insertTask']);
    expect(getListRow(list.id)!.remote_id).not.toBeNull();
    expect(getTaskRow(t.id)!.remote_id).not.toBeNull();
    expect(result.blocked).toBe(0);
  });

  it('clear hides completed tasks on the server rather than deleting them', async () => {
    const listId = boundList();
    const t = createTask({ title: 'done thing', listId });
    await h.push();
    setStatus([t.id], true);
    await h.push();
    clearCompleted(listId);
    h.google.clearCalls();
    await h.push();
    expect(methods()).toEqual(['clearCompleted']);
    const remote = h.google.task(getTaskRow(t.id)!.remote_id!)!;
    expect(remote.hidden).toBe(true);
    expect(remote.deleted).toBe(false);
  });

  it('a list rename and delete reach the tasklists endpoints', async () => {
    const listId = boundList('Old name');
    updateList({ id: listId, title: 'New name' });
    await h.push();
    expect(methods()).toContain('patchTaskList');
    deleteList(listId);
    h.google.clearCalls();
    await h.push();
    expect(methods()).toEqual(['deleteTaskList']);
  });
});

describe('push: previous is a SOFT reference', () => {
  it('orders inserts after the nearest EARLIER sibling that Google already knows', async () => {
    const listId = boundList();
    const a = createTask({ title: 'A', listId, previousId: 'end' });
    await h.push(); // only A is synced
    const b = createTask({ title: 'B', listId, previousId: 'end' });
    h.google.clearCalls();
    await h.push();
    const insert = h.google.calls().find((c) => c.method === 'insertTask')!;
    expect(insert.args[2]).toMatchObject({ previous: getTaskRow(a.id)!.remote_id! });
    expect(b.id).toBeTruthy();
  });

  it('omits `previous` for the first item instead of blocking on an unsynced sibling', async () => {
    const listId = boundList();
    createTask({ title: 'Second', listId, previousId: 'end' });
    const first = createTask({ title: 'First', listId, previousId: null });
    h.google.clearCalls();
    await h.push();
    const inserts = h.google.calls().filter((c) => c.method === 'insertTask');
    // "First" sorts ahead of everything, so it has no earlier synced sibling.
    const firstCall = inserts.find((c) => (c.args[1] as { title: string }).title === 'First')!;
    expect((firstCall.args[2] as { previous?: string }).previous).toBeUndefined();
    expect(first.id).toBeTruthy();
  });
});

describe('push: readiness and blocking', () => {
  it('blocked entries do not burn an attempt counter', async () => {
    const list = createList({ title: 'Later' });
    const t = createTask({ title: 'Child of an unsynced list', listId: list.id });
    h.google.failNext('insertTaskList', new NetworkError(new Error('down'), false), 3);

    await h.push();
    const taskRow = listOutboxRows().find((r) => r.entity_id === t.id)!;
    expect(taskRow.status).toBe('blocked');
    expect(taskRow.attempts).toBe(0); // blocked is NOT a failure
    expect(taskRow.blocked_passes).toBe(1);
  });

  it('parks a dependency that never resolves after three blocked passes', async () => {
    const list = createList({ title: 'Later' });
    const t = createTask({ title: 'Orphan', listId: list.id });
    h.google.failNext('insertTaskList', new ApiError(400, { message: 'bad' }, false), 5);

    for (let i = 0; i < 4; i++) await h.push();

    const row = listOutboxRows(['pending', 'blocked']).find((r) => r.entity_id === t.id);
    const parked = listParked();
    expect(row).toBeUndefined();
    expect(parked.some((r) => r.entity_id === t.id && r.last_error_code === 'dependency_failed')).toBe(true);
    expect(parked.some((r) => r.entity_id === list.id)).toBe(true);
  });

  it('later entries for the same entity wait behind a stalled one (FIFO per entity)', async () => {
    const listId = boundList();
    const t = createTask({ title: 'A', listId });
    await h.push();
    updateTask({ id: t.id, patch: { title: 'B' } });
    for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
    updateTask({ id: t.id, patch: { notes: 'n1' } });
    h.google.failNext('patchTask', new NetworkError(new Error('x'), false), 1);

    await h.push();
    const rows = listOutboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(1);
  });

  it('drops an entry whose entity no longer exists rather than parking it', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Ghost', listId });
    await h.push();
    updateTask({ id: t.id, patch: { title: 'Ghost renamed' } });
    // Simulate a conflict "discard" that removed the row outright.
    hardDeleteTask(t.id);
    h.google.clearCalls();
    const result = await h.push();
    expect(methods()).toEqual([]);
    expect(result.parked).toBe(0);
    expect(listOutboxRows()).toHaveLength(0);
  });

  it('create-then-delete offline never touches the network', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Typo', listId });
    deleteTasks([t.id]);
    h.google.clearCalls();
    await h.push();
    expect(methods()).toEqual([]);
  });
});

describe('push: failure handling', () => {
  it('a 429 waits exactly as long as Retry-After and does NOT advance attempts', async () => {
    const listId = boundList();
    createTask({ title: 'x', listId });
    h.google.failNext('insertTask', new RateLimitError(45_000, false, 'rateLimitExceeded'), 1);

    const before = h.clock.now();
    const result = await h.push();

    expect(result.retryAfterMs).toBe(45_000);
    const row = listOutboxRows()[0]!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0); // rate limiting is not the entry's fault
    expect(parseInstant(row.next_attempt_at)! - before).toBe(45_000);
  });

  it('a rate limit stops the rest of the drain', async () => {
    const listId = boundList();
    createTask({ title: 'a', listId });
    createTask({ title: 'b', listId });
    h.google.failNext('insertTask', new RateLimitError(1_000, false, 'rateLimitExceeded'), 1);
    h.google.clearCalls();
    await h.push();
    expect(methods()).toEqual(['insertTask']); // not two
  });

  it('transient failures back off exponentially and PARK at 8 — never dropped', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Unlucky', listId });
    h.google.failNext('insertTask', new NetworkError(new Error('down'), false), 20);

    const delays: number[] = [];
    for (let i = 0; i < PARK_AFTER; i++) {
      const at = h.clock.now();
      await h.push();
      const row = listOutboxRows(['pending']).find((r) => r.entity_id === t.id);
      if (row) delays.push(parseInstant(row.next_attempt_at)! - at);
      // Jump past the backoff so the next pass is eligible.
      h.clock.set(at + 600_000);
    }

    expect(delays).toEqual([750, 1500, 3000, 6000, 12_000, 24_000, 48_000]);
    const parked = listParked();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.attempts).toBe(PARK_AFTER);
    expect(parked[0]!.entity_id).toBe(t.id);
    // The optimistic local value stays visible.
    expect(getTaskRow(t.id)!.title).toBe('Unlucky');
  });

  it('a 400 parks immediately — retrying eight times proves nothing', async () => {
    const listId = boundList();
    createTask({ title: 'Rejected', listId });
    h.google.failNext('insertTask', new ApiError(400, { message: 'Title too long' }, false), 1);
    const result = await h.push();
    expect(result.parked).toBe(1);
    const parked = listParked()[0]!;
    expect(parked.attempts).toBe(1);
    expect(parked.last_error_code).toBe('http_400');
    expect(parked.last_error).toMatch(/Title too long/);
  });

  it('an auth failure aborts the drain and leaves the outbox completely intact', async () => {
    const listId = boundList();
    createTask({ title: 'a', listId });
    createTask({ title: 'b', listId });
    h.google.failNext('insertTask', new AuthError('invalid_grant'), 1);

    const result = await h.push();
    expect(result.authError).toBeInstanceOf(AuthError);
    expect(listParked()).toHaveLength(0);
    const rows = listOutboxRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.attempts === 0)).toBe(true);
  });

  it('a 404 on delete is success — already gone is the state we wanted', async () => {
    const listId = boundList();
    const t = createTask({ title: 'x', listId });
    await h.push();
    deleteTasks([t.id]);
    h.google.failNext('deleteTask', new ApiError(404, null, false), 1);
    const result = await h.push();
    expect(result.parked).toBe(0);
    expect(listOutboxRows()).toHaveLength(0);
  });
});

describe('push: conflict pre-check', () => {
  it('drops fields the merge already conceded to the server', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Orig', notes: 'orig notes', listId });
    await h.push();

    updateTask({ id: t.id, patch: { title: 'Local title', notes: 'Local notes' } });
    const entry = listOutboxRows()[0]!;
    expect(payloadOf(entry)).toMatchObject({ kind: 'task.update' });

    // A pull lands in between and resolves `title` in the server's favour.
    rawUpdate(t.id, { title: 'Server title', updated_at: '2999-01-01T00:00:00.000Z', dirty_fields: JSON.stringify(['notes']) });

    h.google.clearCalls();
    await h.push();
    const patch = h.google.calls().find((c) => c.method === 'patchTask')!;
    expect(patch.args[2]).toEqual({ notes: 'Local notes' }); // title is NOT resurrected
  });

  it('marks the entry done when the merge left nothing to send', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Orig', listId });
    await h.push();
    updateTask({ id: t.id, patch: { title: 'Local' } });
    rawUpdate(t.id, { updated_at: '2999-01-01T00:00:00.000Z', dirty_fields: '[]' });

    h.google.clearCalls();
    const result = await h.push();
    expect(methods()).toEqual([]);
    expect(result.pushed).toBe(1);
    expect(listOutboxRows()).toHaveLength(0);
  });

  it('keeps a dirty flag when the user typed again while the request was in flight', async () => {
    const listId = boundList();
    const t = createTask({ title: 'v1', listId });
    await h.push();
    updateTask({ id: t.id, patch: { title: 'v2' } });

    // The user types v3 while the v2 patch is on the wire. Clearing `title`
    // wholesale here is the "text disappears mid-edit" bug.
    const realPatch = h.google.patchTask.bind(h.google);
    h.pushDeps.api.patchTask = (tasklist, task, body, etag) => {
      updateTask({ id: t.id, patch: { title: 'v3' } });
      return realPatch(tasklist, task, body, etag);
    };

    await h.push();
    const row = getTaskRow(t.id)!;
    expect(row.title).toBe('v3');
    expect(JSON.parse(row.dirty_fields)).toContain('title'); // v3 still needs sending
    expect(listOutboxRows(['pending']).length).toBeGreaterThan(0);
  });
});

describe('push: cross-list move', () => {
  it('names the SOURCE list and passes destinationTasklist', async () => {
    const listA = boundList('A');
    const remoteB = h.google.addList('B');
    const listB = createList({ title: 'B' });
      bindListRemoteId(listB.id, remoteB.id, remoteB.etag, remoteB.updated);
    for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });

    const t = createTask({ title: 'Movable', listId: listA });
    await h.push();
    const sourceRemote = h.google.lists()[0]!.id;

    moveTask({ id: t.id, listId: listB.id, parentId: null, previousId: 'end' });
    h.google.clearCalls();
    await h.push();

    const move = h.google.calls().find((c) => c.method === 'moveTask')!;
    expect(move.args[0]).toBe(sourceRemote);
    expect(move.args[2]).toMatchObject({ destinationTasklist: remoteB.id });
    expect(h.google.task(getTaskRow(t.id)!.remote_id!)!.listId).toBe(remoteB.id);
  });
});
