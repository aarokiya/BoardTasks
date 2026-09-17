import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub electron before importing modules that touch it.
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {} } }));

import { openDatabase, closeDatabase, getDb } from '../../src/main/db/connection';
import { createList, getAllLists, deleteList, updateList } from '../../src/main/db/repositories/lists';
import { createTask, deleteTasks, getAllTasks, getTask, moveTask, restoreTasks, searchTasks, setStatus, updateTask, countDue, clearCompleted } from '../../src/main/db/repositories/tasks';
import { listOutbox, payloadOf, getOutboxRow, updateOutbox } from '../../src/main/db/repositories/outbox';
import { asCivil } from '../../src/shared/date/civil';

beforeEach(() => { openDatabase(':memory:'); });
afterEach(() => { closeDatabase(); });

describe('lists repo', () => {
  it('creates a list with an outbox entry', () => {
    const l = createList({ title: 'Work', color: 'blue' });
    expect(getAllLists().map((x) => x.title)).toEqual(['Work']);
    expect(l.sync).toBe('pending');
    expect(listOutbox().map((o) => o.op)).toEqual(['list.create']);
  });
  it('rename coalesces into one pending update', () => {
    const l = createList({ title: 'A' });
    updateOutbox(listOutbox()[0]!.id, { status: 'done' }); // pretend create synced
    updateList({ id: l.id, title: 'B' });
    updateList({ id: l.id, title: 'C' });
    const ob = listOutbox();
    expect(ob).toHaveLength(1);
    expect(payloadOf(getOutboxRow(ob[0]!.id)!)).toEqual({ kind: 'list.update', title: 'C' });
  });
  it('deleting a never-synced list cancels its create instead of enqueuing a delete', () => {
    const l = createList({ title: 'Temp' });
    deleteList(l.id);
    expect(listOutbox()).toHaveLength(0);
    expect(getAllLists()).toHaveLength(0);
  });
});

describe('tasks repo', () => {
  it('creates in the default list, ordering with sort keys', () => {
    const a = createTask({ title: 'A', previousId: 'end' });
    const b = createTask({ title: 'B', previousId: 'end' });
    const c = createTask({ title: 'C', previousId: null });
    const keys = getAllTasks().sort((x, y) => (x.sortKey < y.sortKey ? -1 : 1)).map((t) => t.title);
    expect(keys).toEqual(['C', 'A', 'B']);
    expect(a.listId).toBe(b.listId);
    expect(c.sync).toBe('pending');
    expect(getAllLists()[0]!.title).toBe('My Tasks');
  });
  it('edits to a pending create are absorbed into the create', () => {
    const t = createTask({ title: 'Draft' });
    updateTask({ id: t.id, patch: { title: 'Final', notes: 'n' } });
    const ob = listOutbox().filter((o) => o.entity === 'task');
    expect(ob.map((o) => o.op)).toEqual(['task.create']);
    const p = payloadOf(getOutboxRow(ob[0]!.id)!);
    expect(p.kind === 'task.create' && p.fields.title).toBe('Final');
  });
  it('local-only fields never produce outbox entries', () => {
    const t = createTask({ title: 'X' });
    const before = listOutbox().length;
    updateTask({ id: t.id, patch: { dueTime: '17:00', priority: 1, flagged: true } });
    expect(listOutbox().length).toBe(before);
    const got = getTask(t.id)!;
    expect([got.dueTime, got.priority, got.flagged]).toEqual(['17:00', 1, true]);
  });
  it('completing sets completedAt and enqueues an update once the create is done', () => {
    const t = createTask({ title: 'X' });
    for (const o of listOutbox()) updateOutbox(o.id, { status: 'done' });
    const [done] = setStatus([t.id], true);
    expect(done!.status).toBe('completed');
    expect(done!.completedAt).not.toBeNull();
    const ob = listOutbox();
    expect(ob).toHaveLength(1);
    expect(ob[0]!.description).toMatch(/^Complete/);
  });
  it('enforces one level of nesting', () => {
    const p = createTask({ title: 'P' });
    const c = createTask({ title: 'C', parentId: p.id });
    expect(() => createTask({ title: 'G', parentId: c.id })).toThrow(/one level/);
    expect(() => moveTask({ id: p.id, parentId: c.id, previousId: null })).toThrow();
  });
  it('delete then restore cancels a queued delete; delete of a synced task re-creates on restore', () => {
    const t = createTask({ title: 'X' });
    for (const o of listOutbox()) updateOutbox(o.id, { status: 'done' });
    getDb().prepare('UPDATE tasks SET remote_id = ? WHERE id = ?').run('rem1', t.id);
    deleteTasks([t.id]);
    expect(getAllTasks()).toHaveLength(0);
    expect(listOutbox().map((o) => o.op)).toEqual(['task.delete']);
    restoreTasks([t.id]);
    expect(getAllTasks()).toHaveLength(1);
    expect(listOutbox()).toHaveLength(0);
    // Now simulate the delete having been flushed
    deleteTasks([t.id]);
    for (const o of listOutbox()) updateOutbox(o.id, { status: 'done' });
    restoreTasks([t.id]);
    expect(listOutbox().map((o) => o.op)).toEqual(['task.create']);
    expect(getTask(t.id)!.remoteId).toBeNull();
  });
  it('create-then-delete offline never reaches the outbox', () => {
    const t = createTask({ title: 'X' });
    deleteTasks([t.id]);
    expect(listOutbox().filter((o) => o.entity === 'task')).toHaveLength(0);
  });
  it('deleting a parent takes children along', () => {
    const p = createTask({ title: 'P' });
    createTask({ title: 'C', parentId: p.id });
    const { deletedIds } = deleteTasks([p.id]);
    expect(deletedIds).toHaveLength(2);
    expect(getAllTasks()).toHaveLength(0);
  });
  it('full-text search finds by title and notes prefix', () => {
    createTask({ title: 'Ship release notes', notes: 'mention the sync fix' });
    createTask({ title: 'Buy milk' });
    expect(searchTasks('rel').map((t) => t.title)).toEqual(['Ship release notes']);
    expect(searchTasks('sync').map((t) => t.title)).toEqual(['Ship release notes']);
    expect(searchTasks('milk')).toHaveLength(1);
    expect(searchTasks('"unbalanced')).toEqual([]);
  });
  it('countDue splits today and overdue', () => {
    createTask({ title: 'a', due: asCivil('2026-09-16') });
    createTask({ title: 'b', due: asCivil('2026-09-17') });
    createTask({ title: 'c', due: asCivil('2026-09-18') });
    expect(countDue('2026-09-17')).toEqual({ today: 2, overdue: 1 });
  });
  it('clearCompleted hides completed tasks and enqueues one clear', () => {
    const l = getAllLists()[0] ?? createList({ title: 'L' });
    const t = createTask({ title: 'x', listId: l.id });
    setStatus([t.id], true);
    clearCompleted(l.id);
    expect(getTask(t.id)!.hidden).toBe(true);
    expect(listOutbox().some((o) => o.op === 'task.clear')).toBe(true);
  });
  it('move reorders and reparents', () => {
    const a = createTask({ title: 'A', previousId: 'end' });
    const b = createTask({ title: 'B', previousId: 'end' });
    const c = createTask({ title: 'C', previousId: 'end' });
    moveTask({ id: c.id, parentId: null, previousId: null });
    let order = getAllTasks().sort((x, y) => (x.sortKey < y.sortKey ? -1 : 1)).map((t) => t.title);
    expect(order).toEqual(['C', 'A', 'B']);
    moveTask({ id: b.id, parentId: a.id, previousId: null });
    expect(getTask(b.id)!.parentId).toBe(a.id);
    order = getAllTasks().filter((t) => !t.parentId).sort((x, y) => (x.sortKey < y.sortKey ? -1 : 1)).map((t) => t.title);
    expect(order).toEqual(['C', 'A']);
  });
});
