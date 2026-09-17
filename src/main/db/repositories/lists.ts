import type { TaskList } from '@shared/models';
import { LIMITS } from '@shared/constants';
import { getDb } from '../connection';
import { nowIso } from '../../util/time';
import { uuid } from '../../util/uuid';
import { AppError } from '../../ipc/errors';
import { rowToList, type ListRow } from './mappers';
import { cancelAllFor, enqueue, hasPendingCreate } from './outbox';

const SELECT = `
  SELECT l.*,
    (SELECT COUNT(*) FROM outbox o WHERE o.entity_id = l.id AND o.status IN ('pending','inflight','blocked')) AS pending_count,
    (SELECT COUNT(*) FROM outbox o WHERE o.entity_id = l.id AND o.status = 'parked') AS parked_count
  FROM task_lists l`;

export function getAllLists(): TaskList[] {
  return (getDb().prepare(`${SELECT} WHERE l.deleted = 0 ORDER BY l.position ASC, l.title ASC`).all() as ListRow[]).map(rowToList);
}

export function getList(id: string): TaskList | null {
  const r = getDb().prepare(`${SELECT} WHERE l.id = ?`).get(id) as ListRow | undefined;
  return r ? rowToList(r) : null;
}

export function getListByRemoteId(remoteId: string): TaskList | null {
  const r = getDb().prepare(`${SELECT} WHERE l.remote_id = ?`).get(remoteId) as ListRow | undefined;
  return r ? rowToList(r) : null;
}

export function getDefaultList(): TaskList | null {
  const r = getDb().prepare(`${SELECT} WHERE l.deleted = 0 ORDER BY l.is_default DESC, l.position ASC LIMIT 1`).get() as ListRow | undefined;
  return r ? rowToList(r) : null;
}

/** Creates a local default list if none exists (offline-first: tasks always need a home). */
export function ensureDefaultList(): TaskList {
  const existing = getDefaultList();
  if (existing) return existing;
  return createList({ title: 'My Tasks', color: 'blue', isDefault: true });
}

export function createList(input: { title: string; color?: string; isDefault?: boolean }): TaskList {
  const db = getDb();
  const title = input.title.trim().slice(0, LIMITS.listTitle);
  if (!title) throw new AppError('VALIDATION', 'List name cannot be empty.');
  const id = uuid();
  const now = nowIso();
  db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(position), -1) m FROM task_lists').get() as { m: number }).m;
    db.prepare(
      `INSERT INTO task_lists (id, remote_id, title, color, position, is_default, deleted, local_updated_at, rev) VALUES (?, NULL, ?, ?, ?, ?, 0, ?, 1)`,
    ).run(id, title, input.color ?? 'gray', max + 1, input.isDefault ? 1 : 0, now);
    enqueue({ op: 'list.create', entity: 'list', entityId: id, payload: { kind: 'list.create', title }, description: `Create list "${title}"` });
  })();
  return getList(id)!;
}

export function updateList(input: { id: string; title?: string; color?: string; isDefault?: boolean }): TaskList {
  const db = getDb();
  const cur = getList(input.id);
  if (!cur) throw new AppError('NOT_FOUND', 'List not found.');
  const now = nowIso();
  db.transaction(() => {
    if (input.title !== undefined) {
      const title = input.title.trim().slice(0, LIMITS.listTitle);
      if (!title) throw new AppError('VALIDATION', 'List name cannot be empty.');
      if (title !== cur.title) {
        db.prepare('UPDATE task_lists SET title = ?, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(title, now, input.id);
        enqueue({ op: 'list.update', entity: 'list', entityId: input.id, payload: { kind: 'list.update', title }, description: `Rename list "${cur.title}" → "${title}"` });
      }
    }
    if (input.color !== undefined) db.prepare('UPDATE task_lists SET color = ?, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(input.color, now, input.id);
    if (input.isDefault) {
      db.prepare('UPDATE task_lists SET is_default = 0 WHERE is_default = 1').run();
      db.prepare('UPDATE task_lists SET is_default = 1, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(now, input.id);
    }
  })();
  return getList(input.id)!;
}

export function reorderLists(orderedIds: string[]): TaskList[] {
  const db = getDb();
  const now = nowIso();
  db.transaction(() => {
    orderedIds.forEach((id, i) => db.prepare('UPDATE task_lists SET position = ?, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(i, now, id));
  })();
  return getAllLists();
}

/** Soft-deletes the list and its tasks locally; one outbox entry (Google deletes the tasks with the list). */
export function deleteList(id: string): { deletedTaskIds: string[] } {
  const db = getDb();
  const cur = getList(id);
  if (!cur) throw new AppError('NOT_FOUND', 'List not found.');
  const now = nowIso();
  const taskIds = (db.prepare('SELECT id FROM tasks WHERE list_id = ? AND deleted = 0').all(id) as { id: string }[]).map((r) => r.id);
  db.transaction(() => {
    db.prepare('UPDATE tasks SET deleted = 1, local_updated_at = ?, rev = rev + 1 WHERE list_id = ?').run(now, id);
    db.prepare('UPDATE task_lists SET deleted = 1, is_default = 0, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(now, id);
    for (const t of taskIds) cancelAllFor(t);
    if (cur.remoteId === null && hasPendingCreate(id)) {
      cancelAllFor(id);
    } else {
      cancelAllFor(id);
      enqueue({ op: 'list.delete', entity: 'list', entityId: id, payload: { kind: 'list.delete' }, description: `Delete list "${cur.title}"` });
    }
  })();
  return { deletedTaskIds: taskIds };
}

/** Sync-side helpers (no outbox). */
export function upsertListFromRemote(r: { remoteId: string; title: string; etag: string | null; updated: string | null }): TaskList {
  const db = getDb();
  const now = nowIso();
  const existing = getListByRemoteId(r.remoteId);
  if (existing) {
    db.prepare('UPDATE task_lists SET title = ?, etag = ?, updated_at = ?, local_updated_at = ?, deleted = 0, rev = rev + 1 WHERE id = ?').run(r.title, r.etag, r.updated, now, existing.id);
    return getList(existing.id)!;
  }
  const id = uuid();
  const max = (db.prepare('SELECT COALESCE(MAX(position), -1) m FROM task_lists').get() as { m: number }).m;
  const anyDefault = db.prepare('SELECT 1 FROM task_lists WHERE is_default = 1 AND deleted = 0').get();
  db.prepare(
    `INSERT INTO task_lists (id, remote_id, title, color, position, is_default, deleted, etag, updated_at, local_updated_at, rev) VALUES (?, ?, ?, 'gray', ?, ?, 0, ?, ?, ?, 1)`,
  ).run(id, r.remoteId, r.title, max + 1, anyDefault ? 0 : 1, r.etag, r.updated, now);
  return getList(id)!;
}

export function bindListRemoteId(id: string, remoteId: string, etag: string | null, updated: string | null): void {
  getDb().prepare('UPDATE task_lists SET remote_id = ?, etag = ?, updated_at = ?, rev = rev + 1 WHERE id = ?').run(remoteId, etag, updated, id);
}

export function hardDeleteList(id: string): void {
  getDb().prepare('DELETE FROM task_lists WHERE id = ?').run(id);
}

export function getAllListsIncludingDeleted(): TaskList[] {
  return (getDb().prepare(`${SELECT}`).all() as ListRow[]).map(rowToList);
}

/** Raw row (sync needs remote_id / etag, which TaskList does not carry). */
export function getListRow(id: string): ListRow | null {
  return (getDb().prepare('SELECT * FROM task_lists WHERE id = ?').get(id) as ListRow | undefined) ?? null;
}

/** Undo a soft delete (used when a queued `list.delete` is discarded). */
export function restoreListRow(id: string): void {
  getDb().prepare('UPDATE task_lists SET deleted = 0, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(nowIso(), id);
}
