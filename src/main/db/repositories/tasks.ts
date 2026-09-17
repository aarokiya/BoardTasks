import type { GithubLink, PreviousId, Task, TaskConflict, TaskCreateInput, TaskMoveInput, TaskUpdateInput } from '@shared/models';
import { LIMITS } from '@shared/constants';
import { keyBetween, keyFromPosition } from '@shared/ids';
import { getDb } from '../connection';
import { nowIso } from '../../util/time';
import { uuid } from '../../util/uuid';
import { AppError } from '../../ipc/errors';
import { rowToGithub, rowToTask, type GithubRow, type TaskRow } from './mappers';
import { cancelAllFor, enqueue, findPending, hasPendingCreate, updateOutbox, type TaskWireFields } from './outbox';
import { ensureDefaultList, getList } from './lists';

const SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM outbox o WHERE o.entity_id = t.id AND o.status IN ('pending','inflight','blocked')) AS pending_count,
    (SELECT COUNT(*) FROM outbox o WHERE o.entity_id = t.id AND o.status = 'parked') AS parked_count
  FROM tasks t`;

function githubMap(taskIds?: string[]): Map<string, GithubLink> {
  const db = getDb();
  const rows = (taskIds && taskIds.length <= 500
    ? db.prepare(`SELECT * FROM github_links WHERE task_id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds)
    : db.prepare('SELECT * FROM github_links').all()) as GithubRow[];
  return new Map(rows.map((r) => [r.task_id, rowToGithub(r)]));
}

function hydrate(rows: TaskRow[]): Task[] {
  const gh = githubMap(rows.map((r) => r.id));
  return rows.map((r) => rowToTask(r, gh.get(r.id) ?? null));
}

// ---------- reads ----------

export function getAllTasks(): Task[] {
  return hydrate(getDb().prepare(`${SELECT} WHERE t.deleted = 0 ORDER BY t.list_id, t.sort_key`).all() as TaskRow[]);
}

export function getTask(id: string): Task | null {
  const r = getDb().prepare(`${SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
  return r ? hydrate([r])[0]! : null;
}

export function getTasks(ids: string[]): Task[] {
  if (ids.length === 0) return [];
  return hydrate(getDb().prepare(`${SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as TaskRow[]);
}

export function getTaskByRemoteId(remoteId: string): Task | null {
  const r = getDb().prepare(`${SELECT} WHERE t.remote_id = ?`).get(remoteId) as TaskRow | undefined;
  return r ? hydrate([r])[0]! : null;
}

export function getTaskRow(id: string): TaskRow | null {
  return (getDb().prepare(`${SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined) ?? null;
}

export function searchTasks(q: string, limit = 50): Task[] {
  const trimmed = q.trim();
  if (!trimmed) return [];
  // FTS5 prefix query per term; quote terms to neutralize operators.
  const expr = trimmed.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
  try {
    const rows = getDb()
      .prepare(`${SELECT} WHERE t.rowid IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ? ORDER BY rank LIMIT ?) AND t.deleted = 0`)
      .all(expr, limit) as TaskRow[];
    return hydrate(rows);
  } catch {
    return [];
  }
}

export function childrenOf(id: string): TaskRow[] {
  return getDb().prepare(`SELECT * FROM tasks WHERE parent_id = ? AND deleted = 0 ORDER BY sort_key`).all(id) as TaskRow[];
}

function siblings(listId: string, parentId: string | null): TaskRow[] {
  const db = getDb();
  return (parentId === null
    ? db.prepare(`SELECT * FROM tasks WHERE list_id = ? AND parent_id IS NULL AND deleted = 0 AND hidden = 0 ORDER BY sort_key`).all(listId)
    : db.prepare(`SELECT * FROM tasks WHERE list_id = ? AND parent_id = ? AND deleted = 0 AND hidden = 0 ORDER BY sort_key`).all(listId, parentId)) as TaskRow[];
}

/** Compute a sort key placing an item after `previousId` (null=first, 'end'=last) among siblings. */
function sortKeyFor(listId: string, parentId: string | null, previousId: PreviousId, excludeId?: string): string {
  const sibs = siblings(listId, parentId).filter((s) => s.id !== excludeId);
  if (sibs.length === 0) return keyBetween(null, null);
  if (previousId === 'end') return keyBetween(sibs[sibs.length - 1]!.sort_key, null);
  if (previousId === null) return keyBetween(null, sibs[0]!.sort_key);
  const i = sibs.findIndex((s) => s.id === previousId);
  if (i < 0) return keyBetween(sibs[sibs.length - 1]!.sort_key, null); // soft reference: fall back to end
  const next = sibs[i + 1];
  return keyBetween(sibs[i]!.sort_key, next ? next.sort_key : null);
}

export function wireFields(r: TaskRow): TaskWireFields {
  return { title: r.title, notes: r.notes, status: r.status, due: r.due, completedAt: r.completed_at };
}

function describe(r: TaskRow): string {
  return r.title.trim() ? `"${r.title.trim().slice(0, 60)}"` : 'untitled task';
}

// ---------- local mutations (each: one transaction = row write + outbox) ----------

export function createTask(input: TaskCreateInput): Task {
  const db = getDb();
  const title = input.title.trim().slice(0, LIMITS.taskTitle);
  const listId = input.listId ?? ensureDefaultList().id;
  const list = getList(listId);
  if (!list) throw new AppError('NOT_FOUND', 'List not found.');
  let parentId = input.parentId ?? null;
  if (parentId) {
    const parent = getTaskRow(parentId);
    if (!parent || parent.deleted) throw new AppError('NOT_FOUND', 'Parent task not found.');
    if (parent.parent_id) throw new AppError('VALIDATION', 'Tasks can only be nested one level deep.');
    if (parent.list_id !== listId) parentId = null;
  }
  const id = uuid();
  const now = nowIso();
  const status = 'needsAction' as const;
  db.transaction(() => {
    const sortKey = sortKeyFor(listId, parentId, input.previousId ?? null);
    db.prepare(
      `INSERT INTO tasks (id, remote_id, list_id, title, notes, status, due, due_time, completed_at, parent_id, position, sort_key, priority, flagged, hidden, deleted, remote_deleted, web_view_link, links_json, dirty_fields, created_at, local_updated_at, rev)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 0, 0, 0, NULL, '[]', ?, ?, ?, 1)`,
    ).run(id, listId, title, input.notes ?? '', status, input.due ?? null, input.dueTime ?? null, parentId, sortKey, input.priority ?? 0, input.flagged ? 1 : 0, JSON.stringify(['title', 'notes', 'due', 'status']), now, now);
    enqueue({
      op: 'task.create', entity: 'task', entityId: id,
      payload: { kind: 'task.create', fields: { title, notes: input.notes ?? '', status, due: input.due ?? null, completedAt: null }, parentId, previousId: input.previousId ?? null },
      description: `Create ${title ? `"${title.slice(0, 60)}"` : 'untitled task'}`,
    });
  })();
  return getTask(id)!;
}

const WIRE_KEYS = new Set(['title', 'notes', 'due', 'status']);

export function updateTask(input: TaskUpdateInput): Task {
  const db = getDb();
  const cur = getTaskRow(input.id);
  if (!cur) throw new AppError('NOT_FOUND', 'Task not found.');
  const now = nowIso();
  const patch = { ...input.patch };
  if (patch.title !== undefined) patch.title = patch.title.slice(0, LIMITS.taskTitle);
  if (patch.notes !== undefined) patch.notes = patch.notes.slice(0, LIMITS.taskNotes);

  db.transaction(() => {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: input.id, now };
    const wire: Partial<TaskWireFields> = {};
    const dirty = new Set<string>(JSON.parse(cur.dirty_fields) as string[]);
    const put = (col: string, v: unknown): void => { sets.push(`${col} = @${col}`); params[col] = v; };

    if (patch.title !== undefined && patch.title !== cur.title) { put('title', patch.title); wire.title = patch.title; dirty.add('title'); }
    if (patch.notes !== undefined && patch.notes !== cur.notes) { put('notes', patch.notes); wire.notes = patch.notes; dirty.add('notes'); }
    if (patch.due !== undefined && patch.due !== cur.due) { put('due', patch.due); wire.due = patch.due; dirty.add('due'); if (patch.due === null) put('due_time', null); }
    if (patch.dueTime !== undefined && patch.dueTime !== cur.due_time) put('due_time', patch.dueTime);
    if (patch.priority !== undefined && patch.priority !== cur.priority) put('priority', patch.priority);
    if (patch.flagged !== undefined && (patch.flagged ? 1 : 0) !== cur.flagged) put('flagged', patch.flagged ? 1 : 0);
    if (patch.status !== undefined && patch.status !== cur.status) {
      put('status', patch.status);
      const completedAt = patch.status === 'completed' ? now : null;
      put('completed_at', completedAt);
      wire.status = patch.status;
      wire.completedAt = completedAt;
      dirty.add('status');
      if (patch.status === 'needsAction') put('hidden', 0);
    }
    if (sets.length === 0) return;
    put('dirty_fields', JSON.stringify([...dirty]));
    sets.push('local_updated_at = @now', 'rev = rev + 1');
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);

    const wireKeys = Object.keys(wire).filter((k) => WIRE_KEYS.has(k) || k === 'completedAt');
    if (wireKeys.length > 0) {
      // A still-pending create absorbs the edit: no separate update on the wire.
      const pendingCreate = findPending(input.id, 'task.create');
      if (pendingCreate && pendingCreate.status !== 'inflight') {
        const p = JSON.parse(pendingCreate.payload_json) as { kind: 'task.create'; fields: TaskWireFields; parentId: string | null; previousId: PreviousId };
        p.fields = { ...p.fields, ...wire };
        db.prepare('UPDATE outbox SET payload_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p), now, pendingCreate.id);
      } else {
        const label = wire.status ? (wire.status === 'completed' ? `Complete ${describe(cur)}` : `Reopen ${describe(cur)}`)
          : wire.title !== undefined ? `Rename ${describe(cur)} → "${wire.title.slice(0, 60)}"`
          : wire.due !== undefined ? `Set due date on ${describe(cur)}`
          : `Edit ${describe(cur)}`;
        enqueue({ op: 'task.update', entity: 'task', entityId: input.id, payload: { kind: 'task.update', fields: wire }, description: label, baseEtag: cur.etag, baseUpdatedAt: cur.updated_at });
      }
    }
  })();
  return getTask(input.id)!;
}

export function setStatus(ids: string[], completed: boolean): Task[] {
  const db = getDb();
  const out: Task[] = [];
  db.transaction(() => {
    for (const id of ids) out.push(updateTask({ id, patch: { status: completed ? 'completed' : 'needsAction' } }));
  })();
  return out;
}

export function moveTask(input: TaskMoveInput): Task {
  const db = getDb();
  const cur = getTaskRow(input.id);
  if (!cur || cur.deleted) throw new AppError('NOT_FOUND', 'Task not found.');
  const destListId = input.listId ?? cur.list_id;
  if (!getList(destListId)) throw new AppError('NOT_FOUND', 'List not found.');
  const kids = childrenOf(input.id);
  const parentId = input.parentId;
  if (parentId) {
    if (parentId === input.id) throw new AppError('VALIDATION', 'A task cannot be its own parent.');
    const parent = getTaskRow(parentId);
    if (!parent || parent.deleted) throw new AppError('NOT_FOUND', 'Parent task not found.');
    if (parent.parent_id) throw new AppError('VALIDATION', 'Tasks can only be nested one level deep.');
    if (kids.length > 0) throw new AppError('VALIDATION', 'A task with subtasks cannot become a subtask.');
    if (parent.list_id !== destListId) throw new AppError('VALIDATION', 'Parent must be in the same list.');
  }
  const now = nowIso();
  db.transaction(() => {
    const sortKey = sortKeyFor(destListId, parentId, input.previousId, input.id);
    db.prepare('UPDATE tasks SET list_id = ?, parent_id = ?, sort_key = ?, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(destListId, parentId, sortKey, now, input.id);
    if (destListId !== cur.list_id) {
      for (const k of kids) db.prepare('UPDATE tasks SET list_id = ?, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(destListId, now, k.id);
    }
    const pendingCreate = findPending(input.id, 'task.create');
    if (pendingCreate && pendingCreate.status !== 'inflight') {
      const p = JSON.parse(pendingCreate.payload_json) as { kind: 'task.create'; fields: TaskWireFields; parentId: string | null; previousId: PreviousId; listId?: string };
      p.parentId = parentId;
      p.previousId = input.previousId;
      db.prepare('UPDATE outbox SET payload_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p), now, pendingCreate.id);
      if (destListId !== cur.list_id) db.prepare('UPDATE outbox SET updated_at = ? WHERE id = ?').run(now, pendingCreate.id);
    } else {
      enqueue({ op: 'task.move', entity: 'task', entityId: input.id, payload: { kind: 'task.move', parentId, previousId: input.previousId, destListId }, description: `Move ${describe(cur)}` });
    }
  })();
  return getTask(input.id)!;
}

/** Soft delete + trash snapshot; children go with the parent. Create-then-delete never touches the network. */
export function deleteTasks(ids: string[]): { deletedIds: string[] } {
  const db = getDb();
  const now = nowIso();
  const deletedIds: string[] = [];
  db.transaction(() => {
    for (const id of ids) {
      const cur = getTaskRow(id);
      if (!cur || cur.deleted) continue;
      const all = [cur, ...childrenOf(id)];
      for (const r of all) {
        db.prepare('INSERT OR REPLACE INTO trash (task_id, snapshot, deleted_at) VALUES (?, ?, ?)').run(r.id, JSON.stringify(r), now);
        db.prepare('UPDATE tasks SET deleted = 1, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(now, r.id);
        deletedIds.push(r.id);
      }
      if (cur.remote_id === null && hasPendingCreate(id)) {
        for (const r of all) cancelAllFor(r.id);
      } else {
        for (const r of all) cancelAllFor(r.id);
        enqueue({ op: 'task.delete', entity: 'task', entityId: id, payload: { kind: 'task.delete' }, description: `Delete ${describe(cur)}`, baseEtag: cur.etag });
      }
    }
  })();
  return { deletedIds };
}

/** Undo of delete. If the delete is still queued, cancel it; otherwise re-create on the server. */
export function restoreTasks(ids: string[]): Task[] {
  const db = getDb();
  const now = nowIso();
  const restored: string[] = [];
  db.transaction(() => {
    for (const id of ids) {
      const cur = getTaskRow(id);
      if (!cur || !cur.deleted) continue;
      const pendingDelete = findPending(id, 'task.delete');
      const all = [cur, ...(db.prepare('SELECT * FROM tasks WHERE parent_id = ? AND deleted = 1').all(id) as TaskRow[])];
      for (const r of all) {
        db.prepare('UPDATE tasks SET deleted = 0, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(now, r.id);
        db.prepare('DELETE FROM trash WHERE task_id = ?').run(r.id);
        restored.push(r.id);
      }
      if (pendingDelete && pendingDelete.status !== 'inflight') {
        updateOutbox(pendingDelete.id, { status: 'done' });
      } else {
        for (const r of all) {
          db.prepare('UPDATE tasks SET remote_id = NULL, etag = NULL, position = NULL, rev = rev + 1 WHERE id = ?').run(r.id);
          enqueue({
            op: 'task.create', entity: 'task', entityId: r.id,
            payload: { kind: 'task.create', fields: wireFields(r), parentId: r.parent_id, previousId: 'end' },
            description: `Restore ${describe(r)}`,
          });
        }
      }
    }
  })();
  return getTasks(restored);
}

export function clearCompleted(listId: string): { changedIds: string[] } {
  const db = getDb();
  const now = nowIso();
  const ids = (db.prepare(`SELECT id FROM tasks WHERE list_id = ? AND status = 'completed' AND hidden = 0 AND deleted = 0`).all(listId) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return { changedIds: [] };
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET hidden = 1, local_updated_at = ?, rev = rev + 1 WHERE list_id = ? AND status = 'completed' AND hidden = 0 AND deleted = 0`).run(now, listId);
    enqueue({ op: 'task.clear', entity: 'list', entityId: listId, payload: { kind: 'task.clear' }, description: 'Clear completed tasks' });
  })();
  return { changedIds: ids };
}

export function resolveConflict(id: string, resolution: 'keepLocal' | 'useServer' | 'restore' | 'discard'): Task | null {
  const db = getDb();
  const cur = getTaskRow(id);
  if (!cur) throw new AppError('NOT_FOUND', 'Task not found.');
  const conflict = cur.conflict_json ? (JSON.parse(cur.conflict_json) as TaskConflict) : null;
  if (!conflict) return getTask(id);
  const now = nowIso();
  db.transaction(() => {
    if (resolution === 'discard') {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      cancelAllFor(id);
      return;
    }
    if (resolution === 'useServer') {
      const s = conflict.server;
      db.prepare('UPDATE tasks SET title = COALESCE(?, title), notes = COALESCE(?, notes), status = COALESCE(?, status), due = ?, dirty_fields = ?, conflict_json = NULL, local_updated_at = ?, rev = rev + 1 WHERE id = ?')
        .run(s.title ?? null, s.notes ?? null, s.status ?? null, 'due' in s ? (s.due ?? null) : cur.due, '[]', now, id);
      cancelAllFor(id);
      return;
    }
    // keepLocal / restore: push our version. If the server deleted it, re-create.
    db.prepare('UPDATE tasks SET conflict_json = NULL, remote_deleted = 0, local_updated_at = ?, rev = rev + 1 WHERE id = ?').run(now, id);
    if (conflict.remoteDeleted || resolution === 'restore') {
      db.prepare('UPDATE tasks SET remote_id = NULL, etag = NULL, position = NULL WHERE id = ?').run(id);
      cancelAllFor(id);
      const r = getTaskRow(id)!;
      enqueue({ op: 'task.create', entity: 'task', entityId: id, payload: { kind: 'task.create', fields: wireFields(r), parentId: r.parent_id, previousId: 'end' }, description: `Restore ${describe(r)}` });
    } else {
      const r = getTaskRow(id)!;
      const fields: Partial<TaskWireFields> = {};
      for (const f of conflict.fields) {
        if (f === 'title') fields.title = r.title;
        if (f === 'notes') fields.notes = r.notes;
        if (f === 'due') fields.due = r.due;
        if (f === 'status') { fields.status = r.status; fields.completedAt = r.completed_at; }
      }
      enqueue({ op: 'task.update', entity: 'task', entityId: id, payload: { kind: 'task.update', fields }, description: `Keep my changes to ${describe(r)}`, baseEtag: null, baseUpdatedAt: null });
    }
  })();
  return getTask(id);
}

// ---------- counts for badges / notifications ----------

export function countDue(today: string): { today: number; overdue: number } {
  const r = getDb()
    .prepare(`SELECT SUM(CASE WHEN due <= ? THEN 1 ELSE 0 END) t, SUM(CASE WHEN due < ? THEN 1 ELSE 0 END) o FROM tasks WHERE deleted = 0 AND hidden = 0 AND status = 'needsAction' AND due IS NOT NULL`)
      .get(today, today) as { t: number | null; o: number | null };
  return { today: r.t ?? 0, overdue: r.o ?? 0 };
}

/** Open tasks with a due date, for the notification scheduler. */
export function tasksWithDue(): Task[] {
  return hydrate(getDb().prepare(`${SELECT} WHERE t.deleted = 0 AND t.hidden = 0 AND t.status = 'needsAction' AND t.due IS NOT NULL ORDER BY t.due, t.due_time`).all() as TaskRow[]);
}

// ---------- sync-side raw helpers (no outbox; the sync engine owns semantics) ----------

export function bindTaskRemote(id: string, remote: { remoteId: string; etag: string | null; updated: string | null; position: string | null; webViewLink?: string | null }): void {
  getDb()
    .prepare('UPDATE tasks SET remote_id = ?, etag = ?, updated_at = ?, position = ?, sort_key = COALESCE(?, sort_key), web_view_link = COALESCE(?, web_view_link), rev = rev + 1 WHERE id = ?')
    .run(remote.remoteId, remote.etag, remote.updated, remote.position, remote.position ? keyFromPosition(remote.position) : null, remote.webViewLink ?? null, id);
}

export function rawUpdate(id: string, cols: Record<string, unknown>): void {
  const keys = Object.keys(cols);
  if (keys.length === 0) return;
  getDb().prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, rev = rev + 1 WHERE id = @id`).run({ ...cols, id });
}

export function rawInsert(row: Omit<TaskRow, 'pending_count' | 'parked_count' | 'rev'>): void {
  const keys = Object.keys(row);
  getDb().prepare(`INSERT INTO tasks (${keys.join(', ')}, rev) VALUES (${keys.map((k) => `@${k}`).join(', ')}, 1)`).run(row);
}

export function hardDeleteTask(id: string): void {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function allTaskRowsInList(listId: string): TaskRow[] {
  return getDb().prepare('SELECT * FROM tasks WHERE list_id = ?').all(listId) as TaskRow[];
}
