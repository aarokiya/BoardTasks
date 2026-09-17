import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import type { GoogleTasksApi } from '../../../../src/main/api/google-tasks';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList, deleteList, getListRow } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, deleteTasks, getTaskRow, updateTask } from '../../../../src/main/db/repositories/tasks';
import { runPush, type PushDeps } from '../../../../src/main/sync/push';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * Deleting something whose `create` is already ON THE WIRE.
 *
 * `hasPendingCreate` is true for an INFLIGHT create too, so the delete used to
 * take the "this never has to touch the network" shortcut: it cancelled the
 * outbox entry and queued no delete — while the create was still in flight and
 * about to succeed. The result is an entity that exists on Google forever and
 * nowhere on this machine.
 */

let h: SyncHarness;

function boundList(title = 'Work'): string {
  const list = createList({ title });
  const remote = h.google.lists()[0]!;
  bindListRemoteId(list.id, remote.id, remote.etag, remote.updated);
  for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
  return list.id;
}

/** A push whose first `method` call parks on a gate the test releases. */
function gatedPush(method: 'insertTask' | 'insertTaskList'): { deps: PushDeps; release: () => void; arrived: Promise<void> } {
  let release!: () => void;
  let arrive!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const arrived = new Promise<void>((r) => {
    arrive = r;
  });
  let gated = false;
  const api: GoogleTasksApi = {
    ...h.google,
    async insertTask(...args) {
      if (method === 'insertTask' && !gated) {
        gated = true;
        arrive();
        await gate;
      }
      return h.google.insertTask(...args);
    },
    async insertTaskList(...args) {
      if (method === 'insertTaskList' && !gated) {
        gated = true;
        arrive();
        await gate;
      }
      return h.google.insertTaskList(...args);
    },
  };
  return { deps: { ...h.pushDeps, api }, release, arrived };
}

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
});
afterEach(() => {
  closeDatabase();
});

describe('delete while the create is in flight', () => {
  it('still deletes the task on Google once the create lands', async () => {
    const listId = boundList();
    const task = createTask({ title: 'Ghost', listId, previousId: 'end' });

    const { deps, release, arrived } = gatedPush('insertTask');
    const pushing = runPush(deps);
    await arrived;

    // The user deletes it while `tasks.insert` is on the wire.
    deleteTasks([task.id]);
    release();
    await pushing;

    // The create landed and bound a remote id to a row that is now deleted.
    const row = getTaskRow(task.id);
    expect(row!.deleted).toBe(1);
    expect(row!.remote_id).not.toBeNull();

    // A delete must be queued for it — otherwise the task lives on Google and
    // nowhere else.
    const queued = listOutboxRows(['pending', 'blocked']).filter((r) => r.op === 'task.delete');
    expect(queued).toHaveLength(1);

    await h.push();
    expect(h.google.tasks().filter((t) => t.title === 'Ghost' && !t.deleted)).toHaveLength(0);
  });

  it('still deletes the list on Google once the list create lands', async () => {
    const list = createList({ title: 'Scratch' });

    const { deps, release, arrived } = gatedPush('insertTaskList');
    const pushing = runPush(deps);
    await arrived;

    deleteList(list.id);
    release();
    await pushing;

    const row = getListRow(list.id);
    expect(row!.deleted).toBe(1);
    expect(row!.remote_id).not.toBeNull();

    const queued = listOutboxRows(['pending', 'blocked']).filter((r) => r.op === 'list.delete');
    expect(queued).toHaveLength(1);

    await h.push();
    expect(h.google.lists().some((l) => l.title === 'Scratch')).toBe(false);
  });

  it('still takes the offline shortcut when the create has NOT been sent', () => {
    const listId = boundList();
    const task = createTask({ title: 'Typo', listId, previousId: 'end' });

    deleteTasks([task.id]);

    // Never sent: nothing at all should reach the network.
    expect(listOutboxRows(['pending', 'blocked'])).toHaveLength(0);
  });

  it('queues the edit rather than losing it when the create is in flight', async () => {
    const listId = boundList();
    const task = createTask({ title: 'Book flights', listId, previousId: 'end' });

    const { deps, release, arrived } = gatedPush('insertTask');
    const pushing = runPush(deps);
    await arrived;

    updateTask({ id: task.id, patch: { title: 'Book flights to Lisbon' } });
    release();
    await pushing;

    // The rename could not ride along on the create, so it must be its own entry.
    expect(listOutboxRows(['pending', 'blocked']).map((r) => r.op)).toEqual(['task.update']);

    await h.push();
    const remoteId = getTaskRow(task.id)!.remote_id!;
    expect(h.google.task(remoteId)!.title).toBe('Book flights to Lisbon');
  });
});
