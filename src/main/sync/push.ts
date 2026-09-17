import { googleDueFromCivil, isCivil } from '@shared/date/civil';
import { keyFromPosition } from '@shared/ids';
import type { Logger } from '../logger';
import { ApiError } from '../api/errors';
import { AuthError } from '../auth/types';
import type { GoogleTasksApi } from '../api/google-tasks';
import type { RequestQueue } from '../api/request-queue';
import type { GTask, TaskWriteBody } from '../api/schemas';
import { bindListRemoteId, getListRow } from '../db/repositories/lists';
import type { TaskRow } from '../db/repositories/mappers';
import {
  listOutboxRows,
  payloadOf,
  updateOutbox,
  type OutboxPayload,
  type OutboxRow,
  type TaskWireFields,
} from '../db/repositories/outbox';
import { allTaskRowsInList, bindTaskRemote, getTaskRow, rawUpdate } from '../db/repositories/tasks';
import type { Clock, Random } from './clock';
import { isoAt, parseInstant } from './clock';
import { BLOCKED_PASSES_BEFORE_PARK, classifyError, messageOf, nextDelay, PARK_AFTER } from './backoff';
import { baseOfRemote, emptyChanges, MERGE_FIELDS, type MergeChanges, parseBase, parseDirty } from './merge';

/**
 * Drains the outbox.
 *
 * FIFO by `seq`. An entry is *ready* iff every local id it references resolves
 * to a remote id; otherwise it is **blocked** — which is not a failure and does
 * not burn an attempt counter. Causality is already encoded by construction
 * (you cannot update a task before creating it), so FIFO plus a readiness check
 * is sufficient and a topological sort is unnecessary.
 *
 * `previous` (sibling ordering) is a SOFT reference: if the sibling isn't
 * synced yet we degrade to the nearest earlier synced sibling, or omit it.
 * Blocking a user's task creation because a sibling is slow would be absurd.
 *
 * Entries drain sequentially through the request queue with
 * `serialKey = listId`, so two moves in one list can never land out of order.
 */

export interface PushDeps {
  api: GoogleTasksApi;
  clock: Clock;
  random: Random;
  logger: Logger;
  queue: RequestQueue;
  /** `null` = success. */
  observe(error: unknown): void;
}

export interface PushResult {
  changes: MergeChanges;
  listsTouched: Set<string>;
  pushed: number;
  parked: number;
  blocked: number;
  /** Set when an auth failure aborted the drain: the engine pauses. */
  authError: AuthError | null;
  /** Set when a rate limit aborted the drain. */
  retryAfterMs: number | null;
  dailyLimit: boolean;
}

function emptyResult(): PushResult {
  return { changes: emptyChanges(), listsTouched: new Set(), pushed: 0, parked: 0, blocked: 0, authError: null, retryAfterMs: null, dailyLimit: false };
}

interface Ready {
  ok: true;
  listRemoteId: string;
  /** Local list id — the queue's serial key. */
  listId: string;
  taskRemoteId: string | null;
  parentRemoteId: string | undefined;
  previousRemoteId: string | undefined;
  destListRemoteId: string | undefined;
  /** The list the SERVER currently holds this task in (cross-list moves). */
  sourceListRemoteId: string;
}
type Readiness = Ready | { ok: false; reason: string } | { ok: false; reason: string; drop: true };

export async function runPush(deps: PushDeps): Promise<PushResult> {
  const result = emptyResult();
  const rows = listOutboxRows(['pending', 'blocked']);
  if (rows.length === 0) return result;

  const nowMs = deps.clock.now();
  const now = isoAt(nowMs);
  /** Entities whose earlier entry did not go through: FIFO must hold per entity. */
  const stalled = new Set<string>();

  for (const row of rows) {
    if (stalled.has(row.entity_id)) continue;
    if (row.status === 'pending' && (parseInstant(row.next_attempt_at) ?? 0) > nowMs) {
      stalled.add(row.entity_id);
      continue;
    }

    const readiness = resolve(row);
    if (!readiness.ok) {
      if ('drop' in readiness) {
        // The entity is gone (conflict discarded, list hard-deleted). There is
        // nothing to send and nothing to park.
        updateOutbox(row.id, { status: 'done', last_error: null, last_error_code: null });
        continue;
      }
      const passes = row.blocked_passes + 1;
      if (passes >= BLOCKED_PASSES_BEFORE_PARK) {
        updateOutbox(row.id, { status: 'parked', blocked_passes: passes, last_error: readiness.reason, last_error_code: 'dependency_failed' });
        result.parked++;
      } else {
        // Blocked is not a failure: attempts is deliberately untouched.
        updateOutbox(row.id, { status: 'blocked', blocked_passes: passes, last_error: readiness.reason, last_error_code: 'blocked' });
        result.blocked++;
      }
      stalled.add(row.entity_id);
      continue;
    }

    updateOutbox(row.id, { status: 'inflight', blocked_passes: 0 });
    try {
      await deps.queue.submit({
        priority: 0,
        serialKey: readiness.listId,
        label: row.op,
        run: () => apply(deps, row, readiness, now, result),
      });
      deps.observe(null);
      updateOutbox(row.id, { status: 'done', last_error: null, last_error_code: null });
      result.pushed++;
    } catch (e) {
      deps.observe(e);
      const stop = handleFailure(deps, row, e, nowMs, result);
      stalled.add(row.entity_id);
      if (stop) break;
    }
  }

  return result;
}

function handleFailure(deps: PushDeps, row: OutboxRow, e: unknown, nowMs: number, result: PushResult): boolean {
  const c = classifyError(e);

  if (c.disposition === 'auth' && e instanceof AuthError) {
    // Never park and never drop on auth: unsynced changes surviving a re-auth
    // is the whole point of local-first.
    updateOutbox(row.id, { status: 'pending', last_error: c.message, last_error_code: c.code });
    result.authError = e;
    return true;
  }

  if (c.disposition === 'rate_limited') {
    // Not the entry's fault — do not advance `attempts` towards parking.
    const wait = c.retryAfterMs ?? nextDelay(row.attempts + 1, deps.random);
    updateOutbox(row.id, { status: 'pending', next_attempt_at: isoAt(nowMs + wait), last_error: c.message, last_error_code: c.code });
    result.retryAfterMs = wait;
    result.dailyLimit = c.daily;
    return true;
  }

  if (c.disposition === 'permanent') {
    updateOutbox(row.id, { status: 'parked', attempts: row.attempts + 1, last_error: c.message, last_error_code: c.code });
    result.parked++;
    deps.logger.warn(`outbox ${row.op} parked: ${c.message}`);
    return false;
  }

  const attempts = row.attempts + 1;
  if (attempts >= PARK_AFTER) {
    // Parked entries are NEVER auto-deleted; they surface in the
    // "Changes that didn't sync" sheet with Retry / Discard.
    updateOutbox(row.id, { status: 'parked', attempts, last_error: c.message, last_error_code: c.code });
    result.parked++;
    return false;
  }
  updateOutbox(row.id, {
    status: 'pending',
    attempts,
    next_attempt_at: isoAt(nowMs + nextDelay(attempts, deps.random)),
    last_error: c.message || messageOf(e),
    last_error_code: c.code,
  });
  return false;
}

// ---------- readiness ----------

function blocked(reason: string): Readiness {
  return { ok: false, reason };
}
function drop(reason: string): Readiness {
  return { ok: false, reason, drop: true };
}

function resolve(row: OutboxRow): Readiness {
  const payload = payloadOf(row);
  if (row.entity === 'list' && payload.kind !== 'task.clear') return resolveList(row, payload);
  return resolveTask(row, payload);
}

function resolveList(row: OutboxRow, payload: OutboxPayload): Readiness {
  const list = getListRow(row.entity_id);
  if (!list) return drop('The list no longer exists locally.');
  if (payload.kind === 'list.create') {
    if (list.remote_id !== null) return drop('The list is already on Google.');
    return { ok: true, listRemoteId: '', listId: list.id, taskRemoteId: null, parentRemoteId: undefined, previousRemoteId: undefined, destListRemoteId: undefined, sourceListRemoteId: '' };
  }
  if (list.remote_id === null) return blocked('Waiting for the list to be created on Google.');
  return { ok: true, listRemoteId: list.remote_id, listId: list.id, taskRemoteId: null, parentRemoteId: undefined, previousRemoteId: undefined, destListRemoteId: undefined, sourceListRemoteId: list.remote_id };
}

function resolveTask(row: OutboxRow, payload: OutboxPayload): Readiness {
  if (payload.kind === 'task.clear') {
    const list = getListRow(row.entity_id);
    if (!list) return drop('The list no longer exists locally.');
    if (list.remote_id === null) return blocked('Waiting for the list to be created on Google.');
    return { ok: true, listRemoteId: list.remote_id, listId: list.id, taskRemoteId: null, parentRemoteId: undefined, previousRemoteId: undefined, destListRemoteId: undefined, sourceListRemoteId: list.remote_id };
  }

  const task = getTaskRow(row.entity_id);
  if (!task) return drop('The task no longer exists locally.');
  const list = getListRow(task.list_id);
  if (!list) return drop('The task’s list no longer exists locally.');
  if (list.remote_id === null) return blocked('Waiting for the list to be created on Google.');

  if (payload.kind !== 'task.create' && task.remote_id === null) {
    return blocked('Waiting for the task to be created on Google.');
  }

  let parentId: string | null = null;
  let destListId = task.list_id;
  if (payload.kind === 'task.create') parentId = payload.parentId;
  if (payload.kind === 'task.move') {
    parentId = payload.parentId;
    destListId = payload.destListId;
  }

  let parentRemoteId: string | undefined;
  if (parentId !== null) {
    const parent = getTaskRow(parentId);
    if (!parent) return drop('The parent task no longer exists locally.');
    if (parent.remote_id === null) return blocked('Waiting for the parent task to be created on Google.');
    parentRemoteId = parent.remote_id;
  }

  let destListRemoteId: string | undefined;
  if (payload.kind === 'task.move') {
    const dest = getListRow(destListId);
    if (!dest) return drop('The destination list no longer exists locally.');
    if (dest.remote_id === null) return blocked('Waiting for the destination list to be created on Google.');
    destListRemoteId = dest.remote_id;
  }

  const base = parseBase(task);
  const sourceListRemoteId = base?.listRemoteId ?? list.remote_id;

  return {
    ok: true,
    listRemoteId: list.remote_id,
    listId: list.id,
    taskRemoteId: task.remote_id,
    parentRemoteId,
    previousRemoteId: resolvePrevious(task, destListId, parentId),
    destListRemoteId: destListRemoteId === sourceListRemoteId ? undefined : destListRemoteId,
    sourceListRemoteId,
  };
}

/**
 * Soft sibling reference. The row's own `sort_key` already encodes where the
 * user put it, so "insert after the nearest earlier sibling that Google knows
 * about" covers `null` (first), `'end'` (last) and an explicit id uniformly —
 * and degrades gracefully when the intended sibling is still unsynced.
 */
export function resolvePrevious(task: TaskRow, listId: string, parentId: string | null): string | undefined {
  const siblings = allTaskRowsInList(listId)
    .filter((r) => r.id !== task.id && r.deleted === 0 && r.remote_id !== null && (r.parent_id ?? null) === parentId && r.sort_key < task.sort_key)
    .sort((a, b) => (a.sort_key < b.sort_key ? -1 : 1));
  return siblings.length > 0 ? (siblings[siblings.length - 1]!.remote_id ?? undefined) : undefined;
}

// ---------- execution ----------

function bodyFromWire(fields: Partial<TaskWireFields>, nowMs: number): TaskWriteBody {
  const body: TaskWriteBody = {};
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.notes !== undefined) body.notes = fields.notes;
  if (fields.due !== undefined) body.due = fields.due !== null && isCivil(fields.due) ? googleDueFromCivil(fields.due) : null;
  if (fields.status !== undefined) {
    body.status = fields.status;
    // Google rejects a completed task with no `completed` timestamp, and keeps
    // the old one unless you explicitly null it when reopening.
    body.completed = fields.status === 'completed' ? (fields.completedAt ?? isoAt(nowMs)) : null;
  }
  return body;
}

async function apply(deps: PushDeps, row: OutboxRow, ctx: Ready, now: string, result: PushResult): Promise<void> {
  const payload = payloadOf(row);
  const nowMs = deps.clock.now();

  switch (payload.kind) {
    case 'task.create': {
      const remote = await deps.api.insertTask(ctx.listRemoteId, bodyFromWire(payload.fields, nowMs), {
        parent: ctx.parentRemoteId,
        previous: ctx.previousRemoteId,
      });
      bindTaskRemote(row.entity_id, {
        remoteId: remote.id,
        etag: remote.etag ?? null,
        updated: remote.updated ?? null,
        position: remote.position ?? null,
        webViewLink: remote.webViewLink ?? null,
      });
      settle(row.entity_id, payload.fields, remote, ctx.listRemoteId, now);
      result.changes.touched.add(row.entity_id);
      return;
    }

    case 'task.update': {
      const fields = rederive(row, payload.fields);
      if (fields === null) return; // a pull already merged this away
      const remote = await deps.api.patchTask(ctx.listRemoteId, ctx.taskRemoteId!, bodyFromWire(fields, nowMs));
      settle(row.entity_id, fields, remote, ctx.listRemoteId, now);
      result.changes.touched.add(row.entity_id);
      return;
    }

    case 'task.delete': {
      try {
        await deps.api.deleteTask(ctx.listRemoteId, ctx.taskRemoteId!);
      } catch (e) {
        // Already gone is exactly the state we wanted.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      return;
    }

    case 'task.move': {
      const remote = await deps.api.moveTask(ctx.sourceListRemoteId, ctx.taskRemoteId!, {
        parent: ctx.parentRemoteId,
        previous: ctx.previousRemoteId,
        destinationTasklist: ctx.destListRemoteId,
      });
      settle(row.entity_id, {}, remote, ctx.destListRemoteId ?? ctx.listRemoteId, now);
      result.changes.touched.add(row.entity_id);
      return;
    }

    case 'task.clear': {
      await deps.api.clearCompleted(ctx.listRemoteId);
      result.listsTouched.add(ctx.listId);
      return;
    }

    case 'list.create': {
      const remote = await deps.api.insertTaskList({ title: payload.title });
      bindListRemoteId(row.entity_id, remote.id, remote.etag ?? null, remote.updated ?? null);
      result.listsTouched.add(row.entity_id);
      return;
    }

    case 'list.update': {
      const remote = await deps.api.patchTaskList(ctx.listRemoteId, { title: payload.title });
      bindListRemoteId(row.entity_id, remote.id, remote.etag ?? null, remote.updated ?? null);
      result.listsTouched.add(row.entity_id);
      return;
    }

    case 'list.delete': {
      try {
        await deps.api.deleteTaskList(ctx.listRemoteId);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      result.listsTouched.add(row.entity_id);
      return;
    }
  }
}

/**
 * Conflict pre-check. If the server's `updated` moved past the value captured
 * when this entry was queued, a pull already ran the three-way merge. Re-derive
 * the body from what is STILL dirty so we don't resurrect a value the merge
 * already conceded to the server. Returns null when nothing is left to send.
 */
function rederive(row: OutboxRow, fields: Partial<TaskWireFields>): Partial<TaskWireFields> | null {
  const task = getTaskRow(row.entity_id);
  if (!task) return null;
  if (row.base_updated_at === null || task.updated_at === row.base_updated_at) return fields;

  const dirty = parseDirty(task);
  const out: Partial<TaskWireFields> = {};
  for (const f of MERGE_FIELDS) {
    if (fields[f] === undefined || !dirty.has(f)) continue;
    if (f === 'title') out.title = task.title;
    if (f === 'notes') out.notes = task.notes;
    if (f === 'due') out.due = task.due;
    if (f === 'status') {
      out.status = task.status;
      out.completedAt = task.completed_at;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Record the server's answer: new base, cleared dirty flags, fresh etag/position. */
function settle(localId: string, pushed: Partial<TaskWireFields>, remote: GTask, listRemoteId: string, now: string): void {
  const cur = getTaskRow(localId);
  if (!cur) return;
  const dirty = parseDirty(cur);
  const currentWire: TaskWireFields = { title: cur.title, notes: cur.notes, status: cur.status, due: cur.due, completedAt: cur.completed_at };
  for (const f of MERGE_FIELDS) {
    // Only clear a dirty flag when the local value still equals what we sent:
    // the user may have typed again while the request was in flight.
    if (pushed[f] !== undefined && pushed[f] === currentWire[f]) dirty.delete(f);
  }
  const cols: Record<string, unknown> = {
    etag: remote.etag ?? null,
    updated_at: remote.updated ?? cur.updated_at,
    position: remote.position ?? cur.position,
    base_json: JSON.stringify(baseOfRemote(remote, listRemoteId)),
    dirty_fields: JSON.stringify([...dirty]),
    local_updated_at: now,
  };
  if (remote.position) cols['sort_key'] = keyFromPosition(remote.position);
  rawUpdate(localId, cols);
}
