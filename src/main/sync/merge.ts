import type { CivilDate } from '@shared/date/civil';
import { civilFromGoogleDue } from '@shared/date/civil';
import { keyFromPosition } from '@shared/ids';
import type { TaskConflict, TaskLink } from '@shared/models';
import type { GTask } from '../api/schemas';
import type { TaskRow } from '../db/repositories/mappers';
import type { TaskWireFields } from '../db/repositories/outbox';
import { getTaskRow, getTaskRowByRemoteId, hardDeleteTask, rawInsert, rawUpdate } from '../db/repositories/tasks';
import { uuid } from '../util/uuid';

/**
 * Three-way per-field merge: base (last-known server state, `base_json`) vs
 * local vs remote, with `dirty_fields` recording which fields the user touched
 * since that base.
 *
 * The asymmetry — local wins for dirty fields, server wins otherwise — is about
 * recency of intent. Overwriting a field the user just edited produces the
 * single most infuriating bug class in sync software: text disappearing
 * mid-edit. Per-field means a remote due-date change and a local title change
 * BOTH survive with zero user involvement.
 *
 * `parent`, `position` and `hidden` are server-owned and always server-wins:
 * fighting the server over ordering causes visible list jitter.
 *
 * The pull is written as an idempotent merge, not a delta application, so it
 * is correct whether or not tombstones flow with `updatedMin` and whether or
 * not `updatedMin` is inclusive — both of which Google leaves undocumented.
 */

export type MergeField = 'title' | 'notes' | 'status' | 'due';
export const MERGE_FIELDS: readonly MergeField[] = ['title', 'notes', 'status', 'due'];

export interface MergeChanges {
  /** Local ids of rows that were inserted or updated. */
  touched: Set<string>;
  /** Local ids of rows that were hard-deleted. */
  deleted: Set<string>;
  /** Local ids that now carry a conflict. */
  conflicts: Set<string>;
}

export function emptyChanges(): MergeChanges {
  return { touched: new Set(), deleted: new Set(), conflicts: new Set() };
}

export function absorb(into: MergeChanges, from: MergeChanges): MergeChanges {
  for (const id of from.touched) into.touched.add(id);
  for (const id of from.deleted) {
    into.deleted.add(id);
    into.touched.delete(id);
  }
  for (const id of from.conflicts) into.conflicts.add(id);
  return into;
}

export interface MergeOptions {
  /** Local list id these items belong to. */
  listId: string;
  /** Google id of that list, recorded in base_json so cross-list moves know
   *  which list the SERVER currently holds the task in. */
  listRemoteId: string;
  now: string;
  /** Remote ids handled elsewhere this pass (duplicate reconciliation). */
  skipRemoteIds?: ReadonlySet<string>;
}

/**
 * `base_json` is the last-known server state. It is written and read only by
 * the sync engine, so it also carries the server-side list id, which the tasks
 * table has nowhere else to put.
 */
export interface TaskBase extends TaskWireFields {
  listRemoteId?: string;
}

export function baseOfRemote(remote: GTask, listRemoteId: string): TaskBase {
  return { ...wireOfRemote(remote), listRemoteId };
}

/** The subset of a remote task we treat as the common base. */
export function wireOfRemote(remote: GTask): TaskWireFields {
  return {
    title: remote.title ?? '',
    notes: remote.notes ?? '',
    status: remote.status ?? 'needsAction',
    due: civilFromGoogleDue(remote.due ?? null),
    completedAt: remote.completed ?? null,
  };
}

export function wireOfRow(r: TaskRow): TaskWireFields {
  return { title: r.title, notes: r.notes, status: r.status, due: r.due, completedAt: r.completed_at };
}

export function parseDirty(r: TaskRow): Set<MergeField> {
  try {
    const arr = JSON.parse(r.dirty_fields) as string[];
    return new Set(arr.filter((f): f is MergeField => (MERGE_FIELDS as readonly string[]).includes(f)));
  } catch {
    return new Set();
  }
}

export function parseBase(r: TaskRow): TaskBase | null {
  if (!r.base_json) return null;
  try {
    return JSON.parse(r.base_json) as TaskBase;
  } catch {
    return null;
  }
}

function parseConflict(r: TaskRow): TaskConflict | null {
  if (!r.conflict_json) return null;
  try {
    return JSON.parse(r.conflict_json) as TaskConflict;
  } catch {
    return null;
  }
}

function linksOf(remote: GTask): TaskLink[] {
  return (remote.links ?? []).map((l) => ({ type: l.type ?? '', description: l.description ?? '', link: l.link ?? '' }));
}

/**
 * Merge one remote task into the local store.
 * Returns the changes it made; safe to call repeatedly with the same input.
 */
export function mergeRemoteTask(remote: GTask, opts: MergeOptions, deferredParents: Map<string, string>): MergeChanges {
  const changes = emptyChanges();
  if (opts.skipRemoteIds?.has(remote.id)) return changes;

  const existing = getTaskRowByRemoteId(remote.id);

  if (remote.deleted === true) {
    if (!existing) return changes;
    const dirty = parseDirty(existing);
    if (dirty.size > 0 && existing.deleted === 0) {
      // Delete-vs-edit: keep the local edit and offer Restore. Restoring
      // creates a NEW task (the Google id is gone) but the stable localId
      // keeps editors, selection and the undo stack intact.
      const conflict: TaskConflict = {
        fields: [...dirty],
        server: {},
        remoteDeleted: true,
        detectedAt: opts.now,
      };
      rawUpdate(existing.id, { remote_deleted: 1, conflict_json: JSON.stringify(conflict), local_updated_at: opts.now });
      changes.touched.add(existing.id);
      changes.conflicts.add(existing.id);
      return changes;
    }
    hardDeleteTask(existing.id);
    changes.deleted.add(existing.id);
    return changes;
  }

  if (!existing) {
    const id = insertFromRemote(remote, opts, deferredParents);
    changes.touched.add(id);
    return changes;
  }

  return mergeIntoExisting(existing, remote, opts, deferredParents);
}

function insertFromRemote(remote: GTask, opts: MergeOptions, deferredParents: Map<string, string>): string {
  const id = uuid();
  const wire = wireOfRemote(remote);
  const parentRow = remote.parent ? getTaskRowByRemoteId(remote.parent) : null;
  if (remote.parent && !parentRow) deferredParents.set(id, remote.parent);

  rawInsert({
    id,
    remote_id: remote.id,
    list_id: opts.listId,
    title: wire.title,
    notes: wire.notes,
    status: wire.status,
    due: wire.due,
    due_time: null,
    completed_at: wire.completedAt,
    parent_id: parentRow?.id ?? null,
    position: remote.position ?? null,
    sort_key: remote.position ? keyFromPosition(remote.position) : keyFromPosition(remote.id),
    priority: 0,
    flagged: 0,
    hidden: remote.hidden === true ? 1 : 0,
    deleted: 0,
    remote_deleted: 0,
    web_view_link: remote.webViewLink ?? null,
    links_json: JSON.stringify(linksOf(remote)),
    etag: remote.etag ?? null,
    updated_at: remote.updated ?? null,
    base_json: JSON.stringify({ ...wire, listRemoteId: opts.listRemoteId }),
    dirty_fields: '[]',
    conflict_json: null,
    created_at: remote.updated ?? opts.now,
    local_updated_at: opts.now,
  });
  return id;
}

function mergeIntoExisting(row: TaskRow, remote: GTask, opts: MergeOptions, deferredParents: Map<string, string>): MergeChanges {
  const changes = emptyChanges();
  const remoteWire = wireOfRemote(remote);
  const localWire = wireOfRow(row);
  // No base yet (first sync of a locally-created row) → treat remote as the
  // base, which makes "server wins unless dirty" fall out correctly.
  const base = parseBase(row) ?? remoteWire;
  const dirty = parseDirty(row);

  const cols: Record<string, unknown> = {};
  const nextDirty = new Set<MergeField>();
  const conflictFields: string[] = [];
  const serverSide: TaskConflict['server'] = {};

  for (const field of MERGE_FIELDS) {
    const localChanged = dirty.has(field);
    const remoteChanged = !sameValue(remoteWire[field], base[field]);

    if (!localChanged) {
      takeRemote(field, remoteWire, localWire, cols);
      continue;
    }
    if (!remoteChanged) {
      nextDirty.add(field);
      continue;
    }
    if (sameValue(remoteWire[field], localWire[field])) {
      // Both moved to the same value: nothing to fight about.
      takeRemote(field, remoteWire, localWire, cols);
      continue;
    }
    if (field === 'status') {
      // Completion beats un-completion when both sides moved. Losing a "done"
      // is worse than losing an "undone": the user redoes one click, not the
      // work. (With only two status values a both-changed DISAGREEMENT cannot
      // arise — if each side left the base they must have landed on the same
      // value — so this is a guard, and the property that actually protects an
      // offline completion is the local-wins rule above: a remote
      // complete-then-reopen leaves status equal to the base, so our
      // `completed` is kept.)
      if (remoteWire.status === 'completed') {
        takeRemote('status', remoteWire, localWire, cols);
      } else {
        nextDirty.add('status');
      }
      continue;
    }
    // Genuine both-changed: keep the local value (recency of intent) and
    // record the server's so the detail pane can offer it.
    nextDirty.add(field);
    conflictFields.push(field);
    if (field === 'title') serverSide.title = remoteWire.title;
    if (field === 'notes') serverSide.notes = remoteWire.notes;
    if (field === 'due') serverSide.due = remoteWire.due as CivilDate | null;
  }

  // Server-owned fields: never contested.
  const parentRow = remote.parent ? getTaskRowByRemoteId(remote.parent) : null;
  if (remote.parent && !parentRow) deferredParents.set(row.id, remote.parent);
  cols['parent_id'] = parentRow?.id ?? (remote.parent ? row.parent_id : null);
  cols['position'] = remote.position ?? null;
  if (remote.position) cols['sort_key'] = keyFromPosition(remote.position);
  cols['hidden'] = remote.hidden === true ? 1 : 0;
  cols['list_id'] = opts.listId;
  cols['web_view_link'] = remote.webViewLink ?? row.web_view_link;
  cols['links_json'] = JSON.stringify(linksOf(remote));
  cols['etag'] = remote.etag ?? null;
  cols['updated_at'] = remote.updated ?? row.updated_at;
  cols['remote_deleted'] = 0;
  cols['base_json'] = JSON.stringify({ ...remoteWire, listRemoteId: opts.listRemoteId });
  cols['dirty_fields'] = JSON.stringify([...nextDirty]);
  cols['local_updated_at'] = opts.now;

  const previous = parseConflict(row);
  if (conflictFields.length > 0) {
    const conflict: TaskConflict = { fields: conflictFields, server: serverSide, remoteDeleted: false, detectedAt: opts.now };
    cols['conflict_json'] = JSON.stringify(conflict);
    changes.conflicts.add(row.id);
  } else if (previous && !previous.remoteDeleted && nextDirty.size > 0) {
    // An unresolved conflict must survive a quiet pull; only a resolution or a
    // genuine convergence clears it.
    cols['conflict_json'] = row.conflict_json;
    changes.conflicts.add(row.id);
  } else {
    cols['conflict_json'] = null;
  }

  // A poll that brings back identical state must not look like a change:
  // otherwise every 60s tick emits data:changed and re-arms the tray badge,
  // the dock count and the whole reminder schedule for nothing.
  if (!differs(row, cols)) return changes;

  rawUpdate(row.id, cols);
  changes.touched.add(row.id);
  return changes;
}

/** True when writing `cols` would actually alter the row (ignoring bookkeeping). */
function differs(row: TaskRow, cols: Record<string, unknown>): boolean {
  const current = row as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(cols)) {
    if (key === 'local_updated_at') continue;
    if ((current[key] ?? null) !== (value ?? null)) return true;
  }
  return false;
}

function takeRemote(field: MergeField, remote: TaskWireFields, local: TaskWireFields, cols: Record<string, unknown>): void {
  switch (field) {
    case 'title':
      cols['title'] = remote.title;
      return;
    case 'notes':
      cols['notes'] = remote.notes;
      return;
    case 'status':
      cols['status'] = remote.status;
      cols['completed_at'] = remote.status === 'completed' ? (remote.completedAt ?? local.completedAt) : null;
      return;
    case 'due':
      cols['due'] = remote.due;
      // `due` is date-only on the wire; the time of day is local-only. A
      // changed date keeps the user's reminder time, a cleared date drops it.
      if (remote.due === null) cols['due_time'] = null;
      return;
  }
}

function sameValue(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Merge a page of remote tasks. Runs a second pass for children whose parent
 * arrived after them (Google paginates in position order, which is not
 * guaranteed to be parents-first).
 */
export function mergeRemoteTasks(items: readonly GTask[], opts: MergeOptions): MergeChanges {
  const changes = emptyChanges();
  const deferredParents = new Map<string, string>();
  for (const item of items) absorb(changes, mergeRemoteTask(item, opts, deferredParents));
  for (const [localId, parentRemoteId] of deferredParents) {
    const parent = getTaskRowByRemoteId(parentRemoteId);
    const self = getTaskRow(localId);
    if (!parent || !self || self.parent_id === parent.id) continue;
    rawUpdate(localId, { parent_id: parent.id, local_updated_at: opts.now });
    changes.touched.add(localId);
  }
  return changes;
}

/**
 * The server no longer has this row (discovered by a full reconcile, not by a
 * tombstone). Same rule as an explicit remote delete.
 */
export function applyVanished(row: TaskRow, now: string): MergeChanges {
  const changes = emptyChanges();
  const dirty = parseDirty(row);
  if (dirty.size > 0 && row.deleted === 0) {
    const conflict: TaskConflict = { fields: [...dirty], server: {}, remoteDeleted: true, detectedAt: now };
    rawUpdate(row.id, { remote_deleted: 1, conflict_json: JSON.stringify(conflict), local_updated_at: now });
    changes.touched.add(row.id);
    changes.conflicts.add(row.id);
    return changes;
  }
  hardDeleteTask(row.id);
  changes.deleted.add(row.id);
  return changes;
}

/** Bind a locally-created row to the remote task the server just made for it. */
export function adoptRemoteForLocal(localId: string, remote: GTask, listRemoteId: string, now: string): void {
  const wire = baseOfRemote(remote, listRemoteId);
  rawUpdate(localId, {
    remote_id: remote.id,
    etag: remote.etag ?? null,
    updated_at: remote.updated ?? null,
    position: remote.position ?? null,
    ...(remote.position ? { sort_key: keyFromPosition(remote.position) } : {}),
    web_view_link: remote.webViewLink ?? null,
    base_json: JSON.stringify(wire),
    dirty_fields: '[]',
    local_updated_at: now,
  });
}
