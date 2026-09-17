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
import { allTaskRowsInList, bindTaskRemote, getTaskRow, hasUnresolvedConflict, rawUpdate } from '../db/repositories/tasks';
import type { Clock, Random } from './clock';
import { isoAt, parseInstant } from './clock';
import { BLOCKED_PASSES_BEFORE_PARK, classifyError, messageOf, nextDelay, PARK_AFTER, type OutboxErrorCode } from './backoff';
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
  /**
   * Lists whose pre-push conflict check could not run this cycle. An
   * already-synced task in one of them is held back rather than pushed blind:
   * we have no way to know the server's copy did not move.
   */
  unverifiedLists?: ReadonlySet<string>;
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
  /**
   * Epoch ms of the soonest `next_attempt_at` still ahead of us: an entry we
   * skipped because its backoff has not elapsed, or one we just rescheduled.
   * The scheduler wakes for it; otherwise a 2s backoff would wait for the next
   * poll, which is a minute away at best and fifteen on battery.
   */
  retryAt: number | null;
}

function emptyResult(): PushResult {
  return { changes: emptyChanges(), listsTouched: new Set(), pushed: 0, parked: 0, blocked: 0, authError: null, retryAfterMs: null, dailyLimit: false, retryAt: null };
}

function noteRetry(result: PushResult, atMs: number): void {
  result.retryAt = result.retryAt === null ? atMs : Math.min(result.retryAt, atMs);
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
  /** The etag of the last server state we merged, for If-Match. */
  taskEtag: string | null;
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
    const dueAt = row.status === 'pending' ? (parseInstant(row.next_attempt_at) ?? 0) : 0;
    if (dueAt > nowMs) {
      noteRetry(result, dueAt);
      stalled.add(row.entity_id);
      continue;
    }

    // Held back, not failed: no attempt is burned and `blocked_passes` is
    // untouched, so neither of these can park an entry while it waits.
    const hold = holdReason(deps, row);
    if (hold !== null) {
      updateOutbox(row.id, { status: 'blocked', last_error: hold.reason, last_error_code: hold.code });
      stalled.add(row.entity_id);
      result.blocked++;
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
        updateOutbox(row.id, { status: 'parked', blocked_passes: passes, last_error: readiness.reason, last_error_code: 'DEPENDENCY_FAILED' });
        result.parked++;
      } else {
        // Blocked is not a failure: attempts is deliberately untouched.
        updateOutbox(row.id, { status: 'blocked', blocked_passes: passes, last_error: readiness.reason, last_error_code: 'DEPENDENCY_FAILED' });
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

/**
 * Reasons to leave an entry queued without even trying. Both are "we cannot
 * safely send this yet", never "this failed".
 */
function holdReason(deps: PushDeps, row: OutboxRow): { reason: string; code: OutboxErrorCode } | null {
  if (row.entity !== 'task' || row.op === 'task.clear') return null;
  if (hasUnresolvedConflict(row.entity_id)) {
    return { reason: 'This task changed on Google too. Choose which version to keep.', code: 'CONFLICT' };
  }
  const task = deps.unverifiedLists?.size ? getTaskRow(row.entity_id) : null;
  if (task && task.remote_id !== null && deps.unverifiedLists!.has(task.list_id)) {
    return { reason: "Couldn't check Google for newer changes to this list; holding this change back.", code: 'NETWORK' };
  }
  return null;
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
    noteRetry(result, nowMs + wait);
    result.retryAfterMs = wait;
    result.dailyLimit = c.daily;
    return true;
  }

  if (c.disposition === 'conflict') {
    // A 412: the server's copy moved under our If-Match. Don't fight it — the
    // next cycle's pre-push pull merges the remote change and the entry is
    // re-derived from whatever is still dirty (or raised as a conflict). The
    // attempt counter still advances so a precondition that never clears parks
    // rather than looping forever.
    const attempts = row.attempts + 1;
    const patch = { last_error: c.message, last_error_code: c.code };
    if (attempts >= PARK_AFTER) {
      updateOutbox(row.id, { status: 'parked', attempts, ...patch });
      result.parked++;
    } else {
      updateOutbox(row.id, { status: 'pending', attempts, next_attempt_at: isoAt(nowMs), ...patch });
    }
    return false;
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
  const retryAt = nowMs + nextDelay(attempts, deps.random);
  updateOutbox(row.id, {
    status: 'pending',
    attempts,
    next_attempt_at: isoAt(retryAt),
    last_error: c.message || messageOf(e),
    last_error_code: c.code,
  });
  noteRetry(result, retryAt);
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
    return { ok: true, listRemoteId: '', listId: list.id, taskRemoteId: null, parentRemoteId: undefined, previousRemoteId: undefined, destListRemoteId: undefined, sourceListRemoteId: '', taskEtag: null };
  }
  if (list.remote_id === null) return blocked('Waiting for the list to be created on Google.');
  return { ok: true, listRemoteId: list.remote_id, listId: list.id, taskRemoteId: null, parentRemoteId: undefined, previousRemoteId: undefined, destListRemoteId: undefined, sourceListRemoteId: list.remote_id, taskEtag: null };
}

function resolveTask(row: OutboxRow, payload: OutboxPayload): Readiness {
  if (payload.kind === 'task.clear') {
    const list = getListRow(row.entity_id);
    if (!list) return drop('The list no longer exists locally.');
    if (list.remote_id === null) return blocked('Waiting for the list to be created on Google.');
    return { ok: true, listRemoteId: list.remote_id, listId: list.id, taskRemoteId: null, parentRemoteId: undefined, previousRemoteId: undefined, destListRemoteId: undefined, sourceListRemoteId: list.remote_id, taskEtag: null };
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
    taskEtag: task.etag,
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
      // The SOURCE list, not the local one: a cross-list move queued ahead of
      // us has already changed `list_id` locally while the server still holds
      // the task where it was, and patching the wrong list is a 404.
      // If-Match carries the etag of the last server state we merged, so a copy
      // that moved since then answers 412 instead of being overwritten. Google's
      // support for this is unconfirmed, which is why it is the SECOND line of
      // defence behind the pre-push pull, never the only one.
      const remote = await deps.api.patchTask(ctx.sourceListRemoteId, ctx.taskRemoteId!, bodyFromWire(fields, nowMs), ctx.taskEtag);
      settle(row.entity_id, fields, remote, ctx.sourceListRemoteId, now);
      result.changes.touched.add(row.entity_id);
      return;
    }

    case 'task.delete': {
      try {
        // Same reason as the update above — and here a misaddressed request is
        // worse, because a 404 is deliberately treated as "already gone".
        await deps.api.deleteTask(ctx.sourceListRemoteId, ctx.taskRemoteId!);
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
