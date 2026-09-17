import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, deleteTasks, getTaskRow, moveTask, updateTask } from '../../../../src/main/db/repositories/tasks';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * A cross-list move is applied to the local row IMMEDIATELY, long before
 * `tasks.move` reaches Google. Anything queued behind it therefore has to be
 * addressed to the list the SERVER still holds the task in — which is what
 * `base_json.listRemoteId` records. Using the local `list_id` sends the request
 * to a list the task is not in, and Google answers 404.
 */

let h: SyncHarness;

function bind(title: string, index: number): string {
  const list = createList({ title });
  const remote = h.google.lists()[index] ?? h.google.addList(title);
  bindListRemoteId(list.id, remote.id, remote.etag, remote.updated);
  for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
  return list.id;
}

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
});
afterEach(() => {
  closeDatabase();
});

describe('edits queued behind an optimistic cross-list move', () => {
  it('sends a pending update to the list the server still has the task in', async () => {
    const from = bind('From', 0);
    const to = bind('To', 1);
    const task = createTask({ title: 'Original', listId: from, previousId: 'end' });
    await h.push();
    const remoteId = getTaskRow(task.id)!.remote_id!;

    // Rename, then drag to the other list before either reaches Google.
    updateTask({ id: task.id, patch: { title: 'Renamed' } });
    moveTask({ id: task.id, listId: to, parentId: null, previousId: 'end' });

    const result = await h.push();
    expect(result.parked).toBe(0);
    expect(listOutboxRows(['pending', 'blocked', 'parked'])).toHaveLength(0);

    const server = h.google.task(remoteId)!;
    expect(server.title).toBe('Renamed');
    expect(server.listId).toBe(h.google.lists()[1]!.id);
  });

  it('deletes on Google when the delete is queued after an unsent move', async () => {
    const from = bind('From', 0);
    const to = bind('To', 1);
    const task = createTask({ title: 'Doomed', listId: from, previousId: 'end' });
    await h.push();
    const remoteId = getTaskRow(task.id)!.remote_id!;

    moveTask({ id: task.id, listId: to, parentId: null, previousId: 'end' });
    deleteTasks([task.id]);

    await h.push();
    expect(listOutboxRows(['pending', 'blocked', 'parked'])).toHaveLength(0);
    // A 404 on delete is treated as success, so addressing the wrong list here
    // leaves the task alive on Google and gone from this machine.
    expect(h.google.task(remoteId)!.deleted).toBe(true);
  });

  it('a completed status queued behind a move still lands', async () => {
    const from = bind('From', 0);
    const to = bind('To', 1);
    const task = createTask({ title: 'Tick me', listId: from, previousId: 'end' });
    await h.push();
    const remoteId = getTaskRow(task.id)!.remote_id!;

    updateTask({ id: task.id, patch: { status: 'completed' } });
    moveTask({ id: task.id, listId: to, parentId: null, previousId: 'end' });

    await h.push();
    expect(h.google.task(remoteId)!.status).toBe('completed');
    expect(getTaskRow(task.id)!.list_id).toBe(to);
  });
});
