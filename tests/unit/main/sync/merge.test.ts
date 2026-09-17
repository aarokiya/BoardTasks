import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import type { GTask } from '../../../../src/main/api/schemas';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { upsertListFromRemote } from '../../../../src/main/db/repositories/lists';
import { getTask, getTaskRow, getTaskRowByRemoteId, updateTask } from '../../../../src/main/db/repositories/tasks';
import { applyVanished, mergeRemoteTasks, parseDirty, type MergeOptions } from '../../../../src/main/sync/merge';
import { asCivil } from '../../../../src/shared/date/civil';
import { keyFromPosition } from '../../../../src/shared/ids';

const LIST_REMOTE = 'L-default';
const NOW = '2026-09-17T12:00:00.000Z';
let listId = '';

function opts(over: Partial<MergeOptions> = {}): MergeOptions {
  return { listId, listRemoteId: LIST_REMOTE, now: NOW, ...over };
}

let tick = 0;
function gtask(over: Partial<GTask> & { id: string }): GTask {
  tick++;
  return {
    title: '',
    status: 'needsAction',
    position: String(tick).padStart(20, '0'),
    updated: new Date(Date.UTC(2026, 8, 17, 12, 0, tick)).toISOString(),
    etag: `"e${tick}"`,
    ...over,
  };
}

/** Bring a remote task into the store as a clean, fully-synced local row. */
function seed(remote: GTask): string {
  mergeRemoteTasks([remote], opts());
  return getTaskRowByRemoteId(remote.id)!.id;
}

beforeEach(() => {
  openDatabase(':memory:');
  tick = 0;
  listId = upsertListFromRemote({ remoteId: LIST_REMOTE, title: 'My Tasks', etag: '"l"', updated: NOW }).id;
});
afterEach(() => {
  closeDatabase();
});

describe('merge: new remote tasks', () => {
  it('inserts with a fresh local uuid, clean dirty state and a position-derived sort key', () => {
    const remote = gtask({ id: 'T1', title: 'From phone', notes: 'n', due: '2026-09-20T00:00:00.000Z', position: '00000000000000000042' });
    const changes = mergeRemoteTasks([remote], opts());

    const row = getTaskRowByRemoteId('T1')!;
    expect(changes.touched.has(row.id)).toBe(true);
    expect(row.id).not.toBe('T1'); // stable LOCAL uuid, never the Google id
    expect(row.title).toBe('From phone');
    expect(row.due).toBe('2026-09-20'); // civil date, not an instant
    expect(row.sort_key).toBe(keyFromPosition('00000000000000000042'));
    expect(row.dirty_fields).toBe('[]');
    expect(JSON.parse(row.base_json!)).toMatchObject({ title: 'From phone', notes: 'n', due: '2026-09-20', listRemoteId: LIST_REMOTE });
  });

  it('ignores a tombstone for a task we never had', () => {
    const changes = mergeRemoteTasks([gtask({ id: 'T-gone', deleted: true })], opts());
    expect(changes.touched.size + changes.deleted.size).toBe(0);
  });

  it('is idempotent — merging the same payload twice changes nothing', () => {
    const remote = gtask({ id: 'T1', title: 'Same' });
    seed(remote);
    const before = getTaskRowByRemoteId('T1')!;
    mergeRemoteTasks([remote], opts());
    const after = getTaskRowByRemoteId('T1')!;
    expect(after.id).toBe(before.id);
    expect(after.title).toBe('Same');
    expect(after.dirty_fields).toBe('[]');
  });
});

describe('merge: three-way per field', () => {
  it('server wins for a field the user has not touched', () => {
    const id = seed(gtask({ id: 'T1', title: 'Old', notes: 'keep' }));
    mergeRemoteTasks([gtask({ id: 'T1', title: 'New from phone', notes: 'keep' })], opts());
    expect(getTaskRow(id)!.title).toBe('New from phone');
  });

  it('local wins for a dirty field the server did not move', () => {
    const id = seed(gtask({ id: 'T1', title: 'Old' }));
    updateTask({ id, patch: { title: 'Typed locally' } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'Old' })], opts());
    const row = getTaskRow(id)!;
    expect(row.title).toBe('Typed locally');
    expect([...parseDirty(row)]).toContain('title');
    expect(row.conflict_json).toBeNull();
  });

  it('different fields changed on each side BOTH survive with no user involvement', () => {
    const id = seed(gtask({ id: 'T1', title: 'Orig', notes: '', due: null }));
    updateTask({ id, patch: { title: 'Local title' } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'Orig', due: '2026-10-01T00:00:00.000Z' })], opts());
    const row = getTaskRow(id)!;
    expect(row.title).toBe('Local title');
    expect(row.due).toBe('2026-10-01');
    expect(row.conflict_json).toBeNull();
  });

  it('the same field changed on both sides keeps LOCAL and records a conflict', () => {
    const id = seed(gtask({ id: 'T1', title: 'Orig' }));
    updateTask({ id, patch: { title: 'Mine' } });
    const changes = mergeRemoteTasks([gtask({ id: 'T1', title: 'Theirs' })], opts());

    const task = getTask(id)!;
    expect(task.title).toBe('Mine'); // text must never vanish mid-edit
    expect(task.conflict!.fields).toEqual(['title']);
    expect(task.conflict!.server.title).toBe('Theirs');
    expect(task.conflict!.remoteDeleted).toBe(false);
    expect(task.sync).toBe('conflict');
    expect(changes.conflicts.has(id)).toBe(true);
  });

  it('both sides converging on the same value is not a conflict', () => {
    const id = seed(gtask({ id: 'T1', title: 'Orig' }));
    updateTask({ id, patch: { title: 'Agreed' } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'Agreed' })], opts());
    const row = getTaskRow(id)!;
    expect(row.conflict_json).toBeNull();
    expect(row.dirty_fields).toBe('[]');
  });

  it('an unresolved conflict survives a later quiet pull', () => {
    const id = seed(gtask({ id: 'T1', title: 'Orig' }));
    updateTask({ id, patch: { title: 'Mine' } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'Theirs' })], opts());
    const conflicted = getTaskRow(id)!;
    // Nothing changed remotely this time; the conflict card must not disappear.
    mergeRemoteTasks([gtask({ id: 'T1', title: 'Theirs', etag: conflicted.etag ?? '"x"', updated: conflicted.updated_at ?? NOW })], opts());
    expect(getTask(id)!.conflict).not.toBeNull();
  });
});

describe('merge: status', () => {
  it('an offline completion survives a remote complete-then-reopen round trip', () => {
    // The real shape of "completion beats un-completion": the other device
    // ended up back at the base value, so only OUR change is a change.
    const id = seed(gtask({ id: 'T1', title: 'x', status: 'needsAction' }));
    updateTask({ id, patch: { status: 'completed' } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'x', status: 'needsAction' })], opts());
    expect(getTaskRow(id)!.status).toBe('completed');
  });

  it('a local reopen is kept when the server never moved (dirty beats stale)', () => {
    const id = seed(gtask({ id: 'T1', title: 'x', status: 'completed', completed: '2026-09-16T08:00:00.000Z' }));
    updateTask({ id, patch: { status: 'needsAction' } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'x', status: 'completed', completed: '2026-09-16T08:00:00.000Z' })], opts());
    const row = getTaskRow(id)!;
    expect(row.status).toBe('needsAction');
    expect(row.completed_at).toBeNull();
  });

  it('both sides completing it converges with no conflict', () => {
    const id = seed(gtask({ id: 'T1', title: 'x', status: 'needsAction' }));
    updateTask({ id, patch: { status: 'completed' } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'x', status: 'completed', completed: '2026-09-17T09:00:00.000Z' })], opts());
    const row = getTaskRow(id)!;
    expect(row.status).toBe('completed');
    expect(row.completed_at).toBe('2026-09-17T09:00:00.000Z');
    expect(row.dirty_fields).toBe('[]');
    expect(row.conflict_json).toBeNull();
  });

  it('taking a remote reopen clears completedAt', () => {
    const id = seed(gtask({ id: 'T1', title: 'x', status: 'completed', completed: '2026-09-16T08:00:00.000Z' }));
    mergeRemoteTasks([gtask({ id: 'T1', title: 'x', status: 'needsAction' })], opts());
    expect(getTaskRow(id)!.completed_at).toBeNull();
  });
});

describe('merge: due dates are calendar dates', () => {
  it('a changed remote date keeps the LOCAL reminder time', () => {
    const id = seed(gtask({ id: 'T1', title: 'x', due: '2026-09-20T00:00:00.000Z' }));
    updateTask({ id, patch: { dueTime: '17:30' } }); // local-only, no outbox entry
    mergeRemoteTasks([gtask({ id: 'T1', title: 'x', due: '2026-09-25T00:00:00.000Z' })], opts());
    const row = getTaskRow(id)!;
    expect(row.due).toBe('2026-09-25');
    expect(row.due_time).toBe('17:30');
  });

  it('a removed remote date clears the reminder time too', () => {
    const id = seed(gtask({ id: 'T1', title: 'x', due: '2026-09-20T00:00:00.000Z' }));
    updateTask({ id, patch: { dueTime: '17:30' } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'x', due: null })], opts());
    const row = getTaskRow(id)!;
    expect(row.due).toBeNull();
    expect(row.due_time).toBeNull();
  });

  it('never shifts the day across timezones — 2026-09-18T00:00:00Z stays the 18th', () => {
    const id = seed(gtask({ id: 'T1', title: 'x', due: '2026-09-18T00:00:00.000Z' }));
    expect(getTask(id)!.due).toBe(asCivil('2026-09-18'));
  });

  it('a local due change plus a remote due change conflicts on `due`', () => {
    const id = seed(gtask({ id: 'T1', title: 'x', due: '2026-09-20T00:00:00.000Z' }));
    updateTask({ id, patch: { due: asCivil('2026-09-21') } });
    mergeRemoteTasks([gtask({ id: 'T1', title: 'x', due: '2026-09-22T00:00:00.000Z' })], opts());
    const task = getTask(id)!;
    expect(task.due).toBe('2026-09-21');
    expect(task.conflict!.fields).toEqual(['due']);
    expect(task.conflict!.server.due).toBe('2026-09-22');
  });
});

describe('merge: server-owned fields', () => {
  it('position, hidden and parent always come from the server', () => {
    const parentId = seed(gtask({ id: 'P1', title: 'Parent' }));
    const childId = seed(gtask({ id: 'C1', title: 'Child' }));
    mergeRemoteTasks([gtask({ id: 'C1', title: 'Child', parent: 'P1', position: '00000000000000009999', hidden: true })], opts());
    const row = getTaskRow(childId)!;
    expect(row.parent_id).toBe(parentId);
    expect(row.hidden).toBe(1);
    expect(row.position).toBe('00000000000000009999');
    expect(row.sort_key).toBe(keyFromPosition('00000000000000009999'));
  });

  it('resolves a parent that arrives AFTER its child, in a second pass', () => {
    // Google paginates in position order, which is not guaranteed parents-first.
    mergeRemoteTasks([gtask({ id: 'C1', title: 'Child', parent: 'P1' }), gtask({ id: 'P1', title: 'Parent' })], opts());
    const parent = getTaskRowByRemoteId('P1')!;
    const child = getTaskRowByRemoteId('C1')!;
    expect(child.parent_id).toBe(parent.id);
  });
});

describe('merge: remote deletion', () => {
  it('a clean local row is hard-deleted and reported', () => {
    const id = seed(gtask({ id: 'T1', title: 'x' }));
    const changes = mergeRemoteTasks([gtask({ id: 'T1', deleted: true })], opts());
    expect(changes.deleted.has(id)).toBe(true);
    expect(getTaskRow(id)).toBeNull();
  });

  it('a locally-edited row is KEPT and raises a remoteDeleted conflict', () => {
    const id = seed(gtask({ id: 'T1', title: 'x' }));
    updateTask({ id, patch: { title: 'Still working on this' } });
    const changes = mergeRemoteTasks([gtask({ id: 'T1', deleted: true })], opts());

    const row = getTaskRow(id)!;
    expect(row).not.toBeNull();
    expect(row.remote_deleted).toBe(1);
    expect(changes.conflicts.has(id)).toBe(true);
    expect(getTask(id)!.conflict!.remoteDeleted).toBe(true);
    expect(getTask(id)!.title).toBe('Still working on this');
  });
});

describe('applyVanished (full-reconcile deletion)', () => {
  it('hard-deletes a clean row the server no longer lists', () => {
    const id = seed(gtask({ id: 'T1', title: 'x' }));
    const changes = applyVanished(getTaskRow(id)!, NOW);
    expect(changes.deleted.has(id)).toBe(true);
    expect(getTaskRow(id)).toBeNull();
  });

  it('turns a dirty vanished row into a remoteDeleted conflict instead of losing the edit', () => {
    const id = seed(gtask({ id: 'T1', title: 'x' }));
    updateTask({ id, patch: { notes: 'unsaved thoughts' } });
    const changes = applyVanished(getTaskRow(id)!, NOW);
    expect(changes.conflicts.has(id)).toBe(true);
    expect(getTask(id)!.notes).toBe('unsaved thoughts');
  });
});
