import type { TaskList } from '@shared/models';
import type { Logger } from '../logger';
import type { GoogleTasksApi } from '../api/google-tasks';
import { PAGE_SIZE } from '../api/google-tasks';
import type { GTask, GTaskList } from '../api/schemas';
import type { Priority, RequestQueue } from '../api/request-queue';
import {
  bindListRemoteId,
  getAllListsIncludingDeleted,
  getListByRemoteId,
  getListRow,
  hardDeleteList,
  upsertListFromRemote,
} from '../db/repositories/lists';
import { findPending, hasPendingForEntity, updateOutbox } from '../db/repositories/outbox';
import { allTaskRowsInList, getTaskRowByRemoteId } from '../db/repositories/tasks';
import { getSyncState, setSyncState } from '../db/repositories/sync-state';
import type { Clock } from './clock';
import { isoAt, maxInstant, parseInstant } from './clock';
import { absorb, adoptRemoteForLocal, applyVanished, emptyChanges, type MergeChanges, mergeRemoteTasks } from './merge';

/**
 * Polling pull. There is no push channel in the Tasks API — no webhooks, no
 * watch channels — so this is the only way changes from another device arrive.
 *
 * The watermark is the one thing that has to be exactly right. It is taken
 * from `max(item.updated)` or the HTTP `Date` header — the SERVER's clock,
 * never `Date.now()`. A laptop 45 seconds fast that sets it from local time
 * asks for changes after a moment that has not happened server-side, and every
 * edit in that window is lost forever.
 */

/** Read back 2 minutes before the watermark: covers clock jitter and paging. */
export const WATERMARK_SKEW_MS = 120_000;
export const FULL_RECONCILE_INTERVAL_MS = 12 * 3_600_000;
export const COLD_START_FULL_MS = 24 * 3_600_000;
export const OFFLINE_FULL_MS = 7 * 86_400_000;
/** Adoption window for duplicate-create reconciliation. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;
const MAX_PAGES = 500;

export interface PullDeps {
  api: GoogleTasksApi;
  clock: Clock;
  logger: Logger;
  queue: RequestQueue;
  priority: Priority;
  /** Report every request outcome so the network monitor and AIMD can learn. */
  observe(error: unknown | null): void;
}

export interface PullOptions {
  full?: boolean;
  coldStart?: boolean;
}

export interface PullResult {
  changes: MergeChanges;
  listsTouched: Set<string>;
  listsDeleted: Set<string>;
  /** Lists whose pull ran a full reconcile this cycle. */
  fullLists: string[];
}

export function emptyPullResult(): PullResult {
  return { changes: emptyChanges(), listsTouched: new Set(), listsDeleted: new Set(), fullLists: [] };
}

export function listScope(localListId: string): string {
  return `list:${localListId}`;
}

export function shouldFullReconcile(localListId: string, nowMs: number, opts: PullOptions): boolean {
  if (opts.full === true) return true;
  const st = getSyncState(listScope(localListId));
  if (st.watermark === null) return true;
  const lastFull = parseInstant(st.last_full_sync_at);
  if (lastFull === null) return true;
  if (nowMs - lastFull > FULL_RECONCILE_INTERVAL_MS) return true;
  if (opts.coldStart === true && nowMs - lastFull > COLD_START_FULL_MS) return true;
  const lastSuccess = parseInstant(st.last_success_at);
  if (lastSuccess !== null && nowMs - lastSuccess > OFFLINE_FULL_MS) return true;
  return false;
}

async function run<T>(deps: PullDeps, label: string, fn: () => Promise<T>, serialKey?: string): Promise<T> {
  try {
    const r = await deps.queue.submit({ priority: deps.priority, label, serialKey, run: fn });
    deps.observe(null);
    return r;
  } catch (e) {
    deps.observe(e);
    throw e;
  }
}

/**
 * `tasklists.list` has no `updatedMin`, so it is always a full listing. That
 * makes it the place to (a) adopt a remote list for a locally-created one and
 * (b) notice lists that vanished.
 */
export async function pullLists(deps: PullDeps): Promise<{ lists: TaskList[]; touched: Set<string>; deletedLists: Set<string>; deletedTasks: Set<string> }> {
  const remote: GTaskList[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = await run(deps, 'tasklists.list', () => deps.api.listTaskLists(pageToken));
    remote.push(...p.items);
    if (!p.nextPageToken) break;
    pageToken = p.nextPageToken;
  }

  const touched = new Set<string>();
  adoptLocalLists(remote, touched);

  for (const r of remote) {
    const before = getListByRemoteId(r.id);
    const list = upsertListFromRemote({ remoteId: r.id, title: r.title ?? '', etag: r.etag ?? null, updated: r.updated ?? null });
    if (!before || before.title !== list.title || before.rev !== list.rev) touched.add(list.id);
  }

  const remoteIds = new Set(remote.map((r) => r.id));
  const deletedLists = new Set<string>();
  const deletedTasks = new Set<string>();
  for (const local of getAllListsIncludingDeleted()) {
    if (local.remoteId === null || remoteIds.has(local.remoteId)) continue;
    if (hasPendingForEntity(local.id)) continue; // our own delete is still queued
    for (const row of allTaskRowsInList(local.id)) deletedTasks.add(row.id);
    hardDeleteList(local.id); // tasks cascade via the FK
    deletedLists.add(local.id);
    touched.delete(local.id);
    deps.logger.info(`list ${local.title} removed on Google; deleted locally`);
  }

  const lists = getAllListsIncludingDeleted().filter((l) => !l.remoteId || remoteIds.has(l.remoteId));
  return { lists, touched, deletedLists, deletedTasks };
}

/**
 * FIRST-PULL ADOPTION. An offline first run creates a local "My Tasks" with a
 * queued `list.create`. Google already has a default list with that exact
 * name. Pushing the create would leave the user with two identical lists, so
 * the local one is bound to the remote and the create is cancelled.
 */
function adoptLocalLists(remote: readonly GTaskList[], touched: Set<string>): void {
  const unbound = getAllListsIncludingDeleted().filter((l) => l.remoteId === null);
  if (unbound.length === 0) return;
  const taken = new Set<string>();
  for (const local of unbound) {
    const create = findPending(local.id, 'list.create');
    if (!create) continue;
    const match = remote.find(
      (r) => !taken.has(r.id) && (r.title ?? '').trim().toLowerCase() === local.title.trim().toLowerCase() && getListByRemoteId(r.id) === null,
    );
    if (!match) continue;
    taken.add(match.id);
    bindListRemoteId(local.id, match.id, match.etag ?? null, match.updated ?? null);
    updateOutbox(create.id, { status: 'done', last_error: null, last_error_code: null });
    touched.add(local.id);
  }
}

export async function pullList(deps: PullDeps, list: TaskList, now: string, opts: PullOptions): Promise<{ changes: MergeChanges; full: boolean }> {
  const changes = emptyChanges();
  if (list.remoteId === null) return { changes, full: false };

  const scope = listScope(list.id);
  const state = getSyncState(scope);
  const full = shouldFullReconcile(list.id, deps.clock.now(), opts);
  const updatedMin = full || state.watermark === null ? undefined : isoAt(Math.max(0, (parseInstant(state.watermark) ?? 0) - WATERMARK_SKEW_MS));

  let pageToken: string | undefined;
  let maxUpdated: string | null = null;
  let serverDate: string | null = null;
  const seenRemoteIds = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page++) {
    const p = await run(deps, 'tasks.list', () =>
      deps.api.listTasks({
        tasklist: list.remoteId!,
        updatedMin,
        showCompleted: true,
        showHidden: true,
        showDeleted: true,
        showAssigned: true,
        maxResults: PAGE_SIZE,
        pageToken,
      }),
    );
    serverDate = p.serverDate ?? serverDate;
    for (const item of p.items) {
      maxUpdated = maxInstant(maxUpdated, item.updated ?? null);
      if (item.deleted !== true) seenRemoteIds.add(item.id);
    }
    const skipRemoteIds = await reconcileDuplicates(deps, list, p.items, now);
    absorb(changes, mergeRemoteTasks(p.items, { listId: list.id, listRemoteId: list.remoteId, now, skipRemoteIds }));
    if (!p.nextPageToken) break;
    pageToken = p.nextPageToken;
  }

  if (full) {
    // The only thing that reliably catches deletes if tombstones don't flow
    // with updatedMin: diff the server's key set against ours.
    for (const row of allTaskRowsInList(list.id)) {
      if (row.remote_id === null) continue;
      if (seenRemoteIds.has(row.remote_id)) continue;
      if (hasPendingForEntity(row.id)) continue;
      absorb(changes, applyVanished(row, now));
    }
  }

  // Every page succeeded: only now is it safe to move the watermark.
  const watermark = maxUpdated ?? serverDate ?? state.watermark;
  setSyncState(scope, {
    watermark,
    last_delta_sync_at: now,
    last_success_at: now,
    last_full_sync_at: full ? now : state.last_full_sync_at,
    last_error: null,
    consecutive_errors: 0,
  });
  return { changes, full };
}

/**
 * `tasks.insert` is not idempotent. When a create's response is lost the task
 * may still exist on Google, and the outbox retry makes a second one. Next
 * pull we see one (or two) remote tasks with our title and no local row bound
 * to them: adopt the first for our local row, delete the extras.
 *
 * Guard: only rows whose create was actually ATTEMPTED can have produced a
 * remote task, so a never-sent create can never hijack an unrelated task.
 */
async function reconcileDuplicates(deps: PullDeps, list: TaskList, items: readonly GTask[], now: string): Promise<Set<string>> {
  const skip = new Set<string>();
  const orphans = allTaskRowsInList(list.id).filter((r) => r.remote_id === null && r.deleted === 0);
  if (orphans.length === 0) return skip;

  for (const orphan of orphans) {
    const create = findPending(orphan.id, 'task.create');
    if (!create || create.attempts === 0) continue;
    const createdAt = parseInstant(orphan.created_at);
    const candidates = items.filter((i) => {
      if (i.deleted === true || skip.has(i.id)) return false;
      if ((i.title ?? '') !== orphan.title) return false;
      if (getTaskRowByRemoteId(i.id) !== null) return false;
      const updated = parseInstant(i.updated ?? null);
      return createdAt === null || updated === null || Math.abs(updated - createdAt) <= DUPLICATE_WINDOW_MS;
    });
    if (candidates.length === 0) continue;

    const keep = candidates[0]!;
    adoptRemoteForLocal(orphan.id, keep, list.remoteId!, now);
    updateOutbox(create.id, { status: 'done', last_error: null, last_error_code: null });
    skip.add(keep.id);
    deps.logger.warn(`adopted duplicate remote task ${keep.id} for local ${orphan.id} ("${orphan.title}")`);

    for (const extra of candidates.slice(1)) {
      skip.add(extra.id);
      try {
        await run(deps, 'tasks.delete(dup)', () => deps.api.deleteTask(list.remoteId!, extra.id), list.id);
      } catch (e) {
        // Leaving a duplicate behind is bad; failing the whole pull is worse.
        deps.logger.warn(`could not delete duplicate ${extra.id}`, e);
      }
    }
  }
  return skip;
}

export async function runPull(deps: PullDeps, now: string, opts: PullOptions = {}): Promise<PullResult> {
  const result = emptyPullResult();
  const { lists, touched, deletedLists, deletedTasks } = await pullLists(deps);
  for (const id of touched) result.listsTouched.add(id);
  for (const id of deletedLists) result.listsDeleted.add(id);
  for (const id of deletedTasks) result.changes.deleted.add(id);

  for (const list of lists) {
    if (list.remoteId === null) continue;
    if (getListRow(list.id) === null) continue; // deleted out from under us
    const { changes, full } = await pullList(deps, list, now, opts);
    absorb(result.changes, changes);
    if (full) result.fullLists.push(list.id);
  }

  setSyncState('global', {
    last_delta_sync_at: now,
    last_success_at: now,
    last_full_sync_at: result.fullLists.length > 0 ? now : getSyncState('global').last_full_sync_at,
    last_error: null,
    consecutive_errors: 0,
  });
  return result;
}
