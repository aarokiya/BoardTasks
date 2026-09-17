import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { NetworkError } from '../../../../src/main/api/errors';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, getTaskRow, resolveConflict, updateTask } from '../../../../src/main/db/repositories/tasks';
import { PARK_AFTER } from '../../../../src/main/sync/backoff';
import { runPrePull } from '../../../../src/main/sync/pull';
import { runPush } from '../../../../src/main/sync/push';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * The E2E sequence that did not raise a conflict:
 *
 *   create → sync → another device edits the title → we edit the title →
 *   sync again.
 *
 * A cycle is push-then-pull, and the push's own pre-check compares the row's
 * `updated_at` with the entry's `base_updated_at` — both written by the same
 * pull — so the remote edit was invisible and the push simply overwrote it.
 */

const LOCAL_TITLE = 'Confirm the catering order for 40';
const REMOTE_TITLE = 'Confirm the catering order (from my phone)';

let h: SyncHarness;

function boundList(title = 'Work'): string {
  const list = createList({ title });
  const remote = h.google.lists()[0]!;
  bindListRemoteId(list.id, remote.id, remote.etag, remote.updated);
  for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
  return list.id;
}

/** Drives the exact E2E sequence; returns the local id and the Google id. */
async function race(): Promise<{ id: string; remoteId: string }> {
  const listId = boundList();
  const task = createTask({ title: 'Confirm the catering order', listId, previousId: 'end' });
  await h.cycle();
  const remoteId = getTaskRow(task.id)!.remote_id!;

  h.google.remoteEdit(remoteId, { title: REMOTE_TITLE });
  updateTask({ id: task.id, patch: { title: LOCAL_TITLE } });
  await h.cycle();

  return { id: task.id, remoteId };
}

function entryFor(id: string): ReturnType<typeof listOutboxRows>[number] | undefined {
  return listOutboxRows(['pending', 'blocked', 'parked']).find((r) => r.entity_id === id && r.op === 'task.update');
}

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
});
afterEach(() => {
  closeDatabase();
});

describe('simultaneous edit raises a conflict', () => {
  it('detects it, keeps the local value, and does NOT overwrite the server', async () => {
    const { id, remoteId } = await race();

    const row = getTaskRow(id)!;
    expect(row.conflict_json).not.toBeNull();
    const conflict = JSON.parse(row.conflict_json!) as { fields: string[]; server: { title?: string }; remoteDeleted: boolean };
    expect(conflict.fields).toEqual(['title']);
    expect(conflict.server.title).toBe(REMOTE_TITLE);
    expect(conflict.remoteDeleted).toBe(false);

    // Local keeps what the user typed; the server keeps what the phone sent.
    expect(row.title).toBe(LOCAL_TITLE);
    expect(h.google.task(remoteId)!.title).toBe(REMOTE_TITLE);
  });

  it('holds the queued update back without burning attempts or parking it', async () => {
    const { id, remoteId } = await race();

    const held = entryFor(id)!;
    expect(held.status).toBe('blocked');
    expect(held.last_error_code).toBe('CONFLICT');
    expect(held.attempts).toBe(0);

    // Many more cycles must not turn "waiting for the user" into "failed".
    for (let i = 0; i < PARK_AFTER + 2; i++) await h.cycle();
    const still = entryFor(id)!;
    expect(still.status).toBe('blocked');
    expect(still.attempts).toBe(0);
    expect(getTaskRow(id)!.conflict_json).not.toBeNull();
    expect(h.google.task(remoteId)!.title).toBe(REMOTE_TITLE);
  });

  it("'keepLocal' then pushes the local title", async () => {
    const { id, remoteId } = await race();

    resolveConflict(id, 'keepLocal');
    expect(getTaskRow(id)!.conflict_json).toBeNull();

    await h.cycle();
    expect(h.google.task(remoteId)!.title).toBe(LOCAL_TITLE);
    expect(getTaskRow(id)!.title).toBe(LOCAL_TITLE);
    expect(listOutboxRows(['pending', 'blocked', 'parked'])).toHaveLength(0);
  });

  it("'useServer' adopts the server title and sends nothing", async () => {
    const { id, remoteId } = await race();

    resolveConflict(id, 'useServer');
    expect(getTaskRow(id)!.title).toBe(REMOTE_TITLE);

    h.google.clearCalls();
    await h.cycle();
    expect(h.google.calls().some((c) => c.method === 'patchTask')).toBe(false);
    expect(h.google.task(remoteId)!.title).toBe(REMOTE_TITLE);
    expect(getTaskRow(id)!.title).toBe(REMOTE_TITLE);
    expect(getTaskRow(id)!.conflict_json).toBeNull();
    expect(listOutboxRows(['pending', 'blocked', 'parked'])).toHaveLength(0);
  });

  it('a remote edit to a field the user did NOT touch still merges silently', async () => {
    const listId = boundList();
    const task = createTask({ title: 'Book the venue', listId, previousId: 'end' });
    await h.cycle();
    const remoteId = getTaskRow(task.id)!.remote_id!;

    h.google.remoteEdit(remoteId, { notes: 'Deposit paid' });
    updateTask({ id: task.id, patch: { title: 'Book the venue for June' } });
    await h.cycle();

    const row = getTaskRow(task.id)!;
    expect(row.conflict_json).toBeNull();
    expect(row.notes).toBe('Deposit paid');
    expect(row.title).toBe('Book the venue for June');
    expect(h.google.task(remoteId)!.title).toBe('Book the venue for June');
  });

  it('holds a task back when the pre-push check could not run at all', async () => {
    const listId = boundList();
    const task = createTask({ title: 'Safe', listId, previousId: 'end' });
    await h.cycle();
    const remoteId = getTaskRow(task.id)!.remote_id!;

    h.google.remoteEdit(remoteId, { title: 'Edited elsewhere' });
    updateTask({ id: task.id, patch: { title: 'Edited here' } });

    // The conflict check itself fails: we have no idea whether the server moved.
    h.google.failNext('listTasks', new NetworkError(new Error('down'), false), 1);
    const pre = await runPrePull(h.pullDeps, h.now());
    expect([...pre.unverified]).toEqual([listId]);

    const push = await runPush({ ...h.pushDeps, unverifiedLists: pre.unverified });
    expect(push.pushed).toBe(0);
    expect(push.parked).toBe(0);
    expect(h.google.task(remoteId)!.title).toBe('Edited elsewhere');
    const held = entryFor(task.id)!;
    expect(held.status).toBe('blocked');
    expect(held.attempts).toBe(0);

    // Once the check can run, the conflict surfaces normally.
    h.google.clearFailures();
    await h.cycle();
    expect(getTaskRow(task.id)!.conflict_json).not.toBeNull();
  });

  it('a remote DELETE plus a local edit becomes a Restore-able conflict, not a silent loss', async () => {
    const listId = boundList();
    const task = createTask({ title: 'Deleted elsewhere', listId, previousId: 'end' });
    await h.cycle();
    const remoteId = getTaskRow(task.id)!.remote_id!;

    // Another device deletes it while we have an unpushed edit. Pushing first
    // would clear the dirty marks, and the tombstone would then land on a clean
    // row — which the merge hard-deletes, taking the edit with it.
    h.google.remoteDelete(remoteId);
    updateTask({ id: task.id, patch: { notes: 'edited here after the delete' } });
    await h.cycle({ full: true });

    const row = getTaskRow(task.id);
    expect(row, 'the row must survive so the user can restore it').not.toBeNull();
    expect(row!.notes).toBe('edited here after the delete');
    const conflict = JSON.parse(row!.conflict_json!) as { remoteDeleted: boolean };
    expect(conflict.remoteDeleted).toBe(true);

    // Restore re-creates it on Google under a new id, keeping the local one.
    resolveConflict(task.id, 'restore');
    await h.cycle();
    const restored = getTaskRow(task.id)!;
    expect(restored.conflict_json).toBeNull();
    expect(restored.remote_id).not.toBeNull();
    expect(h.google.task(restored.remote_id!)!.notes).toBe('edited here after the delete');
  });

  it('a create is still pushed while another task in the list is conflicted', async () => {
    const { id } = await race();
    const listId = getTaskRow(id)!.list_id;
    const fresh = createTask({ title: 'Unrelated new task', listId, previousId: 'end' });

    await h.cycle();
    expect(getTaskRow(fresh.id)!.remote_id).not.toBeNull();
    expect(entryFor(id)!.status).toBe('blocked');
  });
});

describe('If-Match is the second line of defence', () => {
  it('a 412 is a conflict, not a parked failure, and resolves on the next cycle', async () => {
    h = createSyncHarness({ google: { enforceIfMatch: true } });
    const listId = boundList();
    const task = createTask({ title: 'Etag test', listId, previousId: 'end' });
    await h.cycle();
    const remoteId = getTaskRow(task.id)!.remote_id!;

    // Move the server's copy without letting the pre-push pull see it, so the
    // only thing standing between us and an overwrite is the precondition.
    h.google.remoteEdit(remoteId, { notes: 'from the phone' });
    updateTask({ id: task.id, patch: { title: 'Etag test, edited' } });
    h.google.failNext('listTasks', new NetworkError(new Error('down'), false), 1);

    const push = await h.push(); // no pre-pull: straight at the precondition
    expect(push.parked).toBe(0);
    const entry = entryFor(task.id);
    if (entry) {
      expect(entry.status).toBe('pending');
      expect(entry.last_error_code).toBe('CONFLICT');
    }

    h.google.clearFailures();
    await h.cycle();
    await h.cycle();
    // Either it merged cleanly or it is a conflict the user owns — never a
    // silent overwrite and never a parked entry.
    const row = getTaskRow(task.id)!;
    expect(row.notes).toBe('from the phone');
    expect(listOutboxRows(['parked'])).toHaveLength(0);
  });
});
