import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { ApiError, NetworkError } from '../../../../src/main/api/errors';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import {
  createList,
  getAllListsIncludingDeleted,
  getListByRemoteId,
  getListRow,
} from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import {
  createTask,
  getAllTasks,
  getTask,
  getTaskRow,
  getTaskRowByRemoteId,
  updateTask,
} from '../../../../src/main/db/repositories/tasks';
import { getSyncState } from '../../../../src/main/db/repositories/sync-state';
import { parseInstant } from '../../../../src/main/sync/clock';
import { listScope, WATERMARK_SKEW_MS } from '../../../../src/main/sync/pull';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * Google does not document whether tombstones flow with `updatedMin`. Rather
 * than guess, the entire suite runs under BOTH answers: if it passes both ways
 * the unknown is neutralised by construction rather than by hoping.
 */
describe.each([
  ['tombstones DO flow with updatedMin', true],
  ['tombstones do NOT flow with updatedMin', false],
])('pull (%s)', (_name, tombstones) => {
  let h: SyncHarness;
  const DEFAULT_LIST = 'L-default';

  beforeEach(() => {
    openDatabase(':memory:');
    h = createSyncHarness({ google: { tombstonesInIncrementalPull: tombstones } });
  });
  afterEach(() => {
    closeDatabase();
  });

  function localListId(): string {
    return getListByRemoteId(DEFAULT_LIST)!.id;
  }

  describe('lists', () => {
    it('creates local lists for everything the server has', async () => {
      h.google.addList('Work');
      const result = await h.pull();
      expect(getAllListsIncludingDeleted().map((l) => l.title).sort()).toEqual(['My Tasks', 'Work']);
      expect(result.listsTouched.size).toBe(2);
    });

    it('FIRST-PULL ADOPTION: the offline "My Tasks" merges with Google\'s default list', async () => {
      // The offline first run makes a local "My Tasks" with a queued create.
      // Pushing it would leave the user with two identical lists.
      const local = createList({ title: 'My Tasks', isDefault: true });
      expect(listOutboxRows(['pending'])).toHaveLength(1);

      await h.pull();

      expect(getListRow(local.id)!.remote_id).toBe(DEFAULT_LIST);
      expect(listOutboxRows(['pending'])).toHaveLength(0); // the create was cancelled
      expect(getAllListsIncludingDeleted()).toHaveLength(1);
    });

    it('adoption is case-insensitive and ignores whitespace', async () => {
      const local = createList({ title: '  my tasks ' });
      await h.pull();
      expect(getListRow(local.id)!.remote_id).toBe(DEFAULT_LIST);
    });

    it('never adopts a list that has no pending create', async () => {
      const { bindListRemoteId } = await import('../../../../src/main/db/repositories/lists');
      const other = h.google.addList('Shared');
      const local = createList({ title: 'Shared' });
      for (const r of listOutboxRows()) updateOutbox(r.id, { status: 'done' });
      await h.pull();
      expect(getListRow(local.id)!.remote_id).toBeNull();
      expect(getListByRemoteId(other.id)!.id).not.toBe(local.id);
      expect(bindListRemoteId).toBeTypeOf('function');
    });

    it('a list deleted on the server is removed locally, with its tasks', async () => {
      const remote = h.google.addList('Doomed');
      h.google.remoteInsert(remote.id, { title: 'inside' });
      await h.pull();
      const localId = getListByRemoteId(remote.id)!.id;
      expect(getAllTasks().some((t) => t.listId === localId)).toBe(true);

      await h.google.deleteTaskList(remote.id);
      const result = await h.pull();

      expect(getListRow(localId)).toBeNull();
      expect(result.listsDeleted.has(localId)).toBe(true);
      expect(result.changes.deleted.size).toBe(1);
    });

    it('a list with a pending outbox entry is NOT deleted by the reconcile', async () => {
      const remote = h.google.addList('Mine');
      await h.pull();
      const localId = getListByRemoteId(remote.id)!.id;
      const { updateList } = await import('../../../../src/main/db/repositories/lists');
      updateList({ id: localId, title: 'Renamed offline' });
      await h.google.deleteTaskList(remote.id);

      await h.pull();
      expect(getListRow(localId)).not.toBeNull();
    });
  });

  describe('tasks and pagination', () => {
    it('pages through 250 items at maxResults=100', async () => {
      for (let i = 0; i < 250; i++) h.google.remoteInsert(DEFAULT_LIST, { title: `Task ${i}` });
      h.google.clearCalls();

      await h.pull();

      const listCalls = h.google.calls().filter((c) => c.method === 'listTasks');
      expect(listCalls).toHaveLength(3);
      expect((listCalls[0]!.args[0] as { maxResults: number }).maxResults).toBe(100);
      expect(getAllTasks()).toHaveLength(250);
    });

    it('does NOT advance the watermark when a later page fails', async () => {
      for (let i = 0; i < 150; i++) h.google.remoteInsert(DEFAULT_LIST, { title: `T${i}` });
      await h.pull();
      const good = getSyncState(listScope(localListId())).watermark;
      expect(good).not.toBeNull();

      h.google.remoteInsert(DEFAULT_LIST, { title: 'brand new' });
      // Page 1 succeeds, page 2 blows up.
      h.google.failNext('listTasks', new ApiError(500, null, true), 1);
      h.google.failNext('listTasks', new ApiError(500, null, true), 0);
      let failed = false;
      try {
        await h.pull();
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(getSyncState(listScope(localListId())).watermark).toBe(good);
    });

    it('sends updatedMin = watermark minus a two-minute safety skew', async () => {
      h.google.remoteInsert(DEFAULT_LIST, { title: 'a' });
      await h.pull();
      const watermark = getSyncState(listScope(localListId())).watermark!;

      h.google.clearCalls();
      await h.pull();
      const params = h.google.calls().find((c) => c.method === 'listTasks')!.args[0] as { updatedMin?: string };
      expect(parseInstant(params.updatedMin!)).toBe(parseInstant(watermark)! - WATERMARK_SKEW_MS);
    });

    it('omits updatedMin entirely on a full reconcile', async () => {
      await h.pull();
      h.google.clearCalls();
      await h.pull({ full: true });
      const params = h.google.calls().find((c) => c.method === 'listTasks')!.args[0] as { updatedMin?: string };
      expect(params.updatedMin).toBeUndefined();
    });

    it('takes the watermark from the SERVER clock, so a skewed server loses nothing', async () => {
      // The server is five minutes BEHIND this machine. Setting the watermark
      // from Date.now() would ask for changes after a moment that has not
      // happened server-side, and lose every edit in that window forever.
      h.google.setSkew(-5 * 60_000);
      const t = h.google.remoteInsert(DEFAULT_LIST, { title: 'written on the slow server' });
      await h.pull();

      const watermark = getSyncState(listScope(localListId())).watermark!;
      expect(parseInstant(watermark)).toBe(parseInstant(t.updated));
      expect(parseInstant(watermark)).toBeLessThan(h.clock.now());

      // A second edit written a minute later must still be inside the window.
      await h.clock.advance(60_000);
      h.google.remoteEdit(t.id, { title: 'edited later' });
      await h.pull();
      expect(getTaskRowByRemoteId(t.id)!.title).toBe('edited later');
    });

    it('falls back to the server Date header when a page is empty', async () => {
      await h.pull();
      const watermark = getSyncState(listScope(localListId())).watermark;
      expect(watermark).toBe(h.google.serverNowIso());
    });

    it('always sends all four show* flags explicitly', async () => {
      h.google.clearCalls();
      await h.pull();
      const params = h.google.calls().find((c) => c.method === 'listTasks')!.args[0] as Record<string, unknown>;
      expect(params['showCompleted']).toBe(true);
      expect(params['showHidden']).toBe(true);
      expect(params['showDeleted']).toBe(true);
      expect(params['showAssigned']).toBe(true);
    });
  });

  describe('deletions', () => {
    it('a remote delete removes the clean local row (tombstone or reconcile)', async () => {
      const t = h.google.remoteInsert(DEFAULT_LIST, { title: 'ephemeral' });
      await h.pull();
      const localId = getTaskRowByRemoteId(t.id)!.id;

      h.google.remoteDelete(t.id);
      // With tombstones the incremental pull sees it; without, the 12-hourly
      // full reconcile is what catches it. Both must converge.
      await h.pull(tombstones ? {} : { full: true });

      expect(getTaskRow(localId)).toBeNull();
    });

    it('the full reconcile deletes rows that vanished without any tombstone', async () => {
      const a = h.google.remoteInsert(DEFAULT_LIST, { title: 'a' });
      h.google.remoteInsert(DEFAULT_LIST, { title: 'b' });
      await h.pull();
      expect(getAllTasks()).toHaveLength(2);

      // Erase it from the server's memory entirely — no tombstone at all.
      h.google.remoteDelete(a.id);
      h.google.options.tombstoneRetentionMs = 0;

      const result = await h.pull({ full: true });
      expect(getAllTasks()).toHaveLength(1);
      expect(result.changes.deleted.size).toBe(1);
    });

    it('a vanished row with local edits becomes a conflict instead of a silent loss', async () => {
      const t = h.google.remoteInsert(DEFAULT_LIST, { title: 'contested' });
      await h.pull();
      const localId = getTaskRowByRemoteId(t.id)!.id;
      updateTask({ id: localId, patch: { notes: 'work I do not want to lose' } });

      h.google.remoteDelete(t.id);
      h.google.options.tombstoneRetentionMs = 0;
      const result = await h.pull({ full: true });

      expect(getTask(localId)!.conflict!.remoteDeleted).toBe(true);
      expect(getTask(localId)!.notes).toBe('work I do not want to lose');
      expect(result.changes.conflicts.has(localId)).toBe(true);
    });

    it('never deletes a row that still has a pending outbox entry', async () => {
      await h.pull();
      const listId = localListId();
      const local = createTask({ title: 'not yet on the server', listId });
      const result = await h.pull({ full: true });
      expect(getTaskRow(local.id)).not.toBeNull();
      expect(result.changes.deleted.has(local.id)).toBe(false);
    });
  });

  describe('duplicate-create reconciliation', () => {
    it('adopts the remote task a lost insert response left behind', async () => {
      await h.pull();
      const listId = localListId();
      const local = createTask({ title: 'Ambiguous create', listId });

      // The insert reached Google; the response did not reach us.
      const orphan = h.google.remoteInsert(DEFAULT_LIST, { title: 'Ambiguous create' });
      const entry = listOutboxRows(['pending'])[0]!;
      updateOutbox(entry.id, { attempts: 1 });

      await h.pull();

      expect(getTaskRow(local.id)!.remote_id).toBe(orphan.id);
      expect(listOutboxRows(['pending', 'blocked'])).toHaveLength(0);
      expect(getAllTasks()).toHaveLength(1); // no duplicate row
    });

    it('deletes the extra copies when the insert actually ran twice', async () => {
      await h.pull();
      const listId = localListId();
      const local = createTask({ title: 'Double sent', listId });
      const first = h.google.remoteInsert(DEFAULT_LIST, { title: 'Double sent' });
      const second = h.google.remoteInsert(DEFAULT_LIST, { title: 'Double sent' });
      updateOutbox(listOutboxRows(['pending'])[0]!.id, { attempts: 2 });

      await h.pull();

      // One copy is adopted (whichever the server lists first), the other is
      // deleted. Either way the user ends up with exactly one task.
      const adopted = getTaskRow(local.id)!.remote_id;
      expect([first.id, second.id]).toContain(adopted);
      const extra = adopted === first.id ? second.id : first.id;
      expect(h.google.task(extra)!.deleted).toBe(true);
      expect(h.google.task(adopted!)!.deleted).toBe(false);
      expect(getAllTasks()).toHaveLength(1);
    });

    it('never hijacks an unrelated task for a create that was never attempted', async () => {
      await h.pull();
      const listId = localListId();
      const local = createTask({ title: 'Same name', listId });
      h.google.remoteInsert(DEFAULT_LIST, { title: 'Same name' }); // someone else's task

      await h.pull(); // attempts is still 0

      expect(getTaskRow(local.id)!.remote_id).toBeNull();
      expect(getAllTasks()).toHaveLength(2);
    });
  });

  describe('resilience', () => {
    it('a partition surfaces the error and leaves the watermark alone', async () => {
      await h.pull();
      const before = getSyncState(listScope(localListId())).watermark;
      h.google.partition();
      await expect(h.pull()).rejects.toBeInstanceOf(NetworkError);
      h.google.heal();
      expect(getSyncState(listScope(localListId())).watermark).toBe(before);
    });

    it('merging the same server state twice is a no-op', async () => {
      h.google.remoteInsert(DEFAULT_LIST, { title: 'stable' });
      await h.pull({ full: true });
      const first = getAllTasks();
      await h.pull({ full: true });
      const second = getAllTasks();
      expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
      expect(second.map((t) => t.title)).toEqual(first.map((t) => t.title));
    });
  });
});
