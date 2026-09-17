import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import type { GTask } from '../../../../src/main/api/schemas';
import { asCivil } from '../../../../src/shared/date/civil';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList, getList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, payloadOf, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, getTaskRow, resolveConflict, updateTask } from '../../../../src/main/db/repositories/tasks';
import { getSyncState } from '../../../../src/main/db/repositories/sync-state';
import { listScope, MAX_PAGES, pullList } from '../../../../src/main/sync/pull';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

let h: SyncHarness;

function boundList(title = 'Work'): string {
  const list = createList({ title });
  const remote = h.google.lists()[0]!;
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

describe('pull pagination safety valve', () => {
  it('holds the watermark back and skips the key-set diff when the page cap is hit', async () => {
    const listId = boundList();
    const local = createTask({ title: 'Mine', listId, previousId: 'end' });
    await h.push();
    const scope = listScope(listId);
    const before = getSyncState(scope).watermark;

    // A server that never stops handing out page tokens.
    let pages = 0;
    h.pullDeps.api.listTasks = () => {
      pages++;
      const item: GTask = {
        id: `remote-${pages}`, title: `Remote ${pages}`, status: 'needsAction',
        updated: '2030-01-01T00:00:00.000Z',
      };
      return Promise.resolve({ items: [item], nextPageToken: `p${pages}`, serverDate: '2030-01-01T00:00:00.000Z' });
    };

    const list = getList(listId)!;
    const { full } = await pullList(h.pullDeps, list, h.now(), { full: true });

    expect(pages).toBe(MAX_PAGES);
    expect(full).toBe(false);
    // A truncated listing is not evidence that anything vanished.
    expect(getTaskRow(local.id)).not.toBeNull();
    // And it must not move the watermark past changes we never read.
    expect(getSyncState(scope).watermark).toBe(before);
    expect(getSyncState(scope).last_full_sync_at).toBeNull();
  });
});

describe('conflict resolution', () => {
  /** Put `id` into a genuine both-changed title/due conflict. */
  async function conflict(listId: string): Promise<string> {
    const t = createTask({ title: 'Original', listId, due: asCivil('2026-09-20'), dueTime: '09:30', priority: 1, flagged: true, previousId: 'end' });
    await h.push();
    const remoteId = getTaskRow(t.id)!.remote_id!;
    h.google.remoteEdit(remoteId, { title: 'Theirs', due: '2026-09-25T00:00:00.000Z' });
    updateTask({ id: t.id, patch: { title: 'Mine', due: asCivil('2026-09-22') } });
    await h.pull({ full: true });
    expect(getTaskRow(t.id)!.conflict_json).not.toBeNull();
    return t.id;
  }

  it('useServer adopts every server field, including a cleared due date', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Original', listId, due: asCivil('2026-09-20'), dueTime: '09:30', previousId: 'end' });
    await h.push();
    const remoteId = getTaskRow(t.id)!.remote_id!;
    h.google.remoteEdit(remoteId, { title: 'Theirs', due: null });
    updateTask({ id: t.id, patch: { title: 'Mine', due: asCivil('2026-09-22') } });
    await h.pull({ full: true });

    resolveConflict(t.id, 'useServer');
    const row = getTaskRow(t.id)!;
    expect(row.title).toBe('Theirs');
    expect(row.due).toBeNull();
    // A cleared date takes the local-only reminder time with it — the same
    // rule the merge applies, so the two paths cannot disagree.
    expect(row.due_time).toBeNull();
    expect(row.dirty_fields).toBe('[]');
    expect(row.conflict_json).toBeNull();
  });

  it('keepLocal queues only the contested fields', async () => {
    const listId = boundList();
    const id = await conflict(listId);

    resolveConflict(id, 'keepLocal');
    const entry = listOutboxRows(['pending']).find((r) => r.op === 'task.update')!;
    const payload = payloadOf(entry);
    expect(payload.kind).toBe('task.update');
    if (payload.kind === 'task.update') {
      expect(payload.fields.title).toBe('Mine');
      expect(payload.fields.due).toBe('2026-09-22');
    }
    expect(getTaskRow(id)!.conflict_json).toBeNull();
  });

  it('restore keeps the local-only fields the server never knew about', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Keep me', listId, due: asCivil('2026-09-20'), dueTime: '07:15', priority: 2, flagged: true, previousId: 'end' });
    await h.push();
    const remoteId = getTaskRow(t.id)!.remote_id!;
    updateTask({ id: t.id, patch: { title: 'Keep me, edited' } });
    h.google.remoteDelete(remoteId);
    await h.pull({ full: true });
    expect(getTaskRow(t.id)!.remote_deleted).toBe(1);

    resolveConflict(t.id, 'restore');
    const row = getTaskRow(t.id)!;
    expect(row.remote_id).toBeNull();
    expect(row.due_time).toBe('07:15');
    expect(row.priority).toBe(2);
    expect(row.flagged).toBe(1);
    expect(row.remote_deleted).toBe(0);

    await h.push();
    const after = getTaskRow(t.id)!;
    expect(after.remote_id).not.toBeNull();
    expect(after.due_time).toBe('07:15');
    expect(after.priority).toBe(2);
    expect(after.flagged).toBe(1);
    expect(h.google.task(after.remote_id!)!.title).toBe('Keep me, edited');
  });

  it('useServer on a task the server deleted accepts the deletion', async () => {
    const listId = boundList();
    const t = createTask({ title: 'Gone', listId, previousId: 'end' });
    await h.push();
    const remoteId = getTaskRow(t.id)!.remote_id!;
    updateTask({ id: t.id, patch: { title: 'Gone, edited' } });
    h.google.remoteDelete(remoteId);
    await h.pull({ full: true });

    resolveConflict(t.id, 'useServer');
    expect(getTaskRow(t.id)).toBeNull();
    expect(listOutboxRows(['pending', 'blocked'])).toHaveLength(0);
  });
});
