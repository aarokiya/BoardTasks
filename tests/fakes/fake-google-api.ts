import { ApiError, NetworkError } from '../../src/main/api/errors';
import type {
  GoogleTasksApi,
  InsertTaskOptions,
  ListTasksParams,
  MoveTaskOptions,
  Page,
} from '../../src/main/api/google-tasks';
import type { GTask, GTaskList, TaskWriteBody } from '../../src/main/api/schemas';

/**
 * An in-memory Google Tasks that reproduces the server's QUIRKS, because a
 * fake that doesn't is a fake that proves nothing:
 *
 *  - `due` is truncated to midnight UTC on write (the time is discarded).
 *  - `parent`/`position` in a request body are IGNORED; hierarchy and order
 *    can only be set with the insert/move query params.
 *  - `position` is an opaque 20-digit string, renumbered on every move.
 *  - `clear` sets `hidden`, it does not delete.
 *  - `delete` leaves a tombstone (`deleted: true`) with configurable retention,
 *    and whether tombstones flow with `updatedMin` is a TOGGLE, because Google
 *    does not document it.
 *  - `updated` comes from the SERVER's clock, which can be skewed relative to
 *    the test clock.
 */

export interface FakeTaskListRow {
  id: string;
  title: string;
  etag: string;
  updated: string;
}

export interface FakeTaskRow {
  id: string;
  listId: string;
  title: string;
  notes: string;
  status: 'needsAction' | 'completed';
  due: string | null;
  completed: string | null;
  deleted: boolean;
  hidden: boolean;
  parent: string | null;
  position: string;
  updated: string;
  etag: string;
  webViewLink: string;
  deletedAt: number | null;
}

export type FakeMethod = keyof GoogleTasksApi;

export interface CallRecord {
  method: FakeMethod;
  args: unknown[];
}

export interface FakeGoogleOptions {
  /** Server epoch ms. Defaults to the same instant the fake clock starts at. */
  now?: () => number;
  /** Server clock offset relative to `now()`. Negative = the server is behind. */
  skewMs?: number;
  /** Google does not document whether tombstones flow with updatedMin. */
  tombstonesInIncrementalPull?: boolean;
  /** How long a tombstone survives before the server forgets it entirely. */
  tombstoneRetentionMs?: number;
  /** Honour If-Match and answer 412 when the etag is stale. */
  enforceIfMatch?: boolean;
  seedList?: string;
}

export interface FakeGoogle extends GoogleTasksApi {
  /** Make the next `times` calls to `method` throw `error`. */
  failNext(method: FakeMethod, error: unknown, times?: number): void;
  /** Every call fails with a NetworkError until `heal()`. */
  partition(): void;
  heal(): void;
  /** Drop any scripted failures that were never consumed. */
  clearFailures(): void;
  /** An edit from another device. */
  remoteEdit(taskId: string, patch: Partial<Pick<FakeTaskRow, 'title' | 'notes' | 'status' | 'due' | 'completed' | 'hidden'>>): FakeTaskRow;
  remoteDelete(taskId: string): void;
  remoteInsert(listId: string, init: Partial<FakeTaskRow> & { title: string }): FakeTaskRow;
  addList(title: string, id?: string): FakeTaskListRow;
  calls(): CallRecord[];
  clearCalls(): void;
  lists(): FakeTaskListRow[];
  tasks(): FakeTaskRow[];
  task(id: string): FakeTaskRow | undefined;
  serverNowIso(): string;
  setSkew(ms: number): void;
  setTombstonesInIncrementalPull(on: boolean): void;
  options: FakeGoogleOptions;
}

const PAD = 20;

function pos(index: number): string {
  return String((index + 1) * 100_000).padStart(PAD, '0');
}

/** Google truncates `due` to midnight UTC: the time component is meaningless. */
export function truncateDue(due: string | null | undefined): string | null {
  if (!due) return null;
  return `${due.slice(0, 10)}T00:00:00.000Z`;
}

export function createFakeGoogle(opts: FakeGoogleOptions = {}): FakeGoogle {
  const options: FakeGoogleOptions = {
    tombstonesInIncrementalPull: true,
    tombstoneRetentionMs: 30 * 86_400_000,
    enforceIfMatch: false,
    skewMs: 0,
    ...opts,
  };
  const nowFn = options.now ?? ((): number => Date.UTC(2026, 8, 17, 12, 0, 0));

  const listRows: FakeTaskListRow[] = [];
  const taskRows: FakeTaskRow[] = [];
  /** Per-list display order of task ids; positions are derived from it. */
  const order = new Map<string, string[]>();
  const failures = new Map<FakeMethod, unknown[]>();
  const log: CallRecord[] = [];
  let partitioned = false;
  let ids = 0;

  function serverMs(): number {
    return nowFn() + (options.skewMs ?? 0);
  }
  function serverNowIso(): string {
    return new Date(serverMs()).toISOString();
  }
  function nextId(prefix: string): string {
    ids++;
    return `${prefix}${String(ids).padStart(6, '0')}`;
  }
  function etag(): string {
    return `"etag-${ids}-${serverMs()}"`;
  }

  function gate(method: FakeMethod, args: unknown[]): void {
    log.push({ method, args });
    if (partitioned) throw new NetworkError(new Error('partitioned'), false);
    const queue = failures.get(method);
    if (queue && queue.length > 0) throw queue.shift();
  }

  function listOf(listId: string): string[] {
    let arr = order.get(listId);
    if (!arr) {
      arr = [];
      order.set(listId, arr);
    }
    return arr;
  }

  function renumber(listId: string): void {
    // Positions are unique within a sibling group and renumbered on every move.
    const groups = new Map<string, number>();
    for (const id of listOf(listId)) {
      const t = taskRows.find((x) => x.id === id);
      if (!t) continue;
      const key = t.parent ?? '';
      const i = groups.get(key) ?? 0;
      groups.set(key, i + 1);
      t.position = pos(i);
    }
  }

  function descendants(id: string): string[] {
    return taskRows.filter((t) => t.parent === id).map((t) => t.id);
  }

  function place(listId: string, id: string, parent: string | null, previous: string | null): void {
    const arr = listOf(listId);
    const without = arr.filter((x) => x !== id);
    let at: number;
    if (previous) {
      const i = without.indexOf(previous);
      if (i < 0) {
        at = without.length;
      } else {
        // Insert after `previous` and after everything nested under it.
        at = i + 1;
        while (at < without.length) {
          const t = taskRows.find((x) => x.id === without[at]);
          if (t && t.parent === previous) at++;
          else break;
        }
      }
    } else if (parent) {
      const i = without.indexOf(parent);
      at = i < 0 ? without.length : i + 1;
    } else {
      at = 0;
    }
    without.splice(at, 0, id);
    order.set(listId, without);
    renumber(listId);
  }

  function purgeTombstones(): void {
    const cutoff = serverMs() - (options.tombstoneRetentionMs ?? Number.POSITIVE_INFINITY);
    for (let i = taskRows.length - 1; i >= 0; i--) {
      const t = taskRows[i]!;
      if (t.deleted && t.deletedAt !== null && t.deletedAt < cutoff) {
        taskRows.splice(i, 1);
        order.set(t.listId, listOf(t.listId).filter((x) => x !== t.id));
      }
    }
  }

  function toGTask(t: FakeTaskRow): GTask {
    const out: GTask = {
      kind: 'tasks#task',
      id: t.id,
      etag: t.etag,
      title: t.title,
      updated: t.updated,
      selfLink: `https://example.invalid/tasks/${t.id}`,
      position: t.position,
      status: t.status,
      webViewLink: t.webViewLink,
    };
    if (t.parent) out.parent = t.parent;
    if (t.notes) out.notes = t.notes;
    if (t.due) out.due = t.due;
    if (t.completed) out.completed = t.completed;
    if (t.deleted) out.deleted = true;
    if (t.hidden) out.hidden = true;
    return out;
  }

  function toGList(l: FakeTaskListRow): GTaskList {
    return { kind: 'tasks#taskList', id: l.id, etag: l.etag, title: l.title, updated: l.updated };
  }

  function requireList(id: string): FakeTaskListRow {
    const l = listRows.find((x) => x.id === id);
    if (!l) throw new ApiError(404, { code: 404, message: 'Task list not found', errors: [{ reason: 'notFound' }] }, false);
    return l;
  }

  function requireTask(listId: string, id: string): FakeTaskRow {
    const t = taskRows.find((x) => x.id === id && x.listId === listId);
    if (!t) throw new ApiError(404, { code: 404, message: 'Task not found', errors: [{ reason: 'notFound' }] }, false);
    return t;
  }

  function addList(title: string, id?: string): FakeTaskListRow {
    const row: FakeTaskListRow = { id: id ?? nextId('L'), title, etag: etag(), updated: serverNowIso() };
    listRows.push(row);
    order.set(row.id, []);
    return row;
  }

  function insertRow(listId: string, init: Partial<FakeTaskRow> & { title: string }, parent: string | null, previous: string | null): FakeTaskRow {
    const row: FakeTaskRow = {
      id: init.id ?? nextId('T'),
      listId,
      title: init.title,
      notes: init.notes ?? '',
      status: init.status ?? 'needsAction',
      due: truncateDue(init.due ?? null),
      completed: init.status === 'completed' ? (init.completed ?? serverNowIso()) : null,
      deleted: false,
      hidden: init.hidden ?? false,
      parent,
      position: pos(0),
      updated: serverNowIso(),
      etag: etag(),
      webViewLink: `https://tasks.google.com/task/${init.id ?? 'x'}`,
      deletedAt: null,
    };
    taskRows.push(row);
    place(listId, row.id, parent, previous);
    return row;
  }

  if (options.seedList !== '') addList(options.seedList ?? 'My Tasks', 'L-default');

  const api: FakeGoogle = {
    options,

    listTaskLists(pageToken) {
      gate('listTaskLists', [pageToken]);
      return Promise.resolve<Page<GTaskList>>({ items: listRows.map(toGList), nextPageToken: null, serverDate: serverNowIso() });
    },

    insertTaskList(body) {
      gate('insertTaskList', [body]);
      return Promise.resolve(toGList(addList(body.title)));
    },

    patchTaskList(tasklist, body) {
      gate('patchTaskList', [tasklist, body]);
      const l = requireList(tasklist);
      l.title = body.title;
      l.updated = serverNowIso();
      l.etag = etag();
      return Promise.resolve(toGList(l));
    },

    deleteTaskList(tasklist) {
      gate('deleteTaskList', [tasklist]);
      requireList(tasklist);
      const i = listRows.findIndex((x) => x.id === tasklist);
      listRows.splice(i, 1);
      for (let j = taskRows.length - 1; j >= 0; j--) if (taskRows[j]!.listId === tasklist) taskRows.splice(j, 1);
      order.delete(tasklist);
      return Promise.resolve();
    },

    listTasks(params: ListTasksParams) {
      gate('listTasks', [params]);
      requireList(params.tasklist);
      purgeTombstones();
      const ordered = listOf(params.tasklist)
        .map((id) => taskRows.find((t) => t.id === id))
        .filter((t): t is FakeTaskRow => t !== undefined);

      const filtered = ordered.filter((t) => {
        if (params.updatedMin && t.updated < params.updatedMin) return false;
        if (t.deleted) {
          if (params.showDeleted !== true) return false;
          // The undocumented behaviour, made explicit and testable.
          if (params.updatedMin && options.tombstonesInIncrementalPull !== true) return false;
          return true;
        }
        if (t.hidden && params.showHidden !== true) return false;
        if (t.status === 'completed' && params.showCompleted !== true) return false;
        if (params.dueMin && (t.due ?? '') < params.dueMin) return false;
        if (params.dueMax && (t.due ?? '') > params.dueMax) return false;
        return true;
      });

      const max = params.maxResults ?? 20;
      const offset = params.pageToken ? Number(params.pageToken) : 0;
      const slice = filtered.slice(offset, offset + max);
      const next = offset + max < filtered.length ? String(offset + max) : null;
      return Promise.resolve<Page<GTask>>({ items: slice.map(toGTask), nextPageToken: next, serverDate: serverNowIso() });
    },

    insertTask(tasklist, body: TaskWriteBody, o?: InsertTaskOptions) {
      gate('insertTask', [tasklist, body, o]);
      requireList(tasklist);
      if (o?.parent) requireTask(tasklist, o.parent);
      const row = insertRow(
        tasklist,
        {
          title: body.title ?? '',
          notes: body.notes ?? '',
          status: body.status ?? 'needsAction',
          due: body.due ?? null,
          completed: body.completed ?? null,
        },
        o?.parent ?? null,
        o?.previous ?? null,
      );
      return Promise.resolve(toGTask(row));
    },

    patchTask(tasklist, task, body: TaskWriteBody, ifMatch) {
      gate('patchTask', [tasklist, task, body, ifMatch]);
      const t = requireTask(tasklist, task);
      if (options.enforceIfMatch === true && ifMatch && ifMatch !== t.etag) {
        throw new ApiError(412, { code: 412, message: 'Precondition failed' }, false);
      }
      // parent and position in a body are silently ignored — matching Google.
      if (body.title !== undefined) t.title = body.title;
      if (body.notes !== undefined) t.notes = body.notes ?? '';
      if (body.due !== undefined) t.due = truncateDue(body.due);
      if (body.status !== undefined) {
        t.status = body.status;
        t.completed = body.status === 'completed' ? (body.completed ?? serverNowIso()) : null;
        if (body.status === 'needsAction') t.hidden = false;
      }
      t.updated = serverNowIso();
      t.etag = etag();
      return Promise.resolve(toGTask(t));
    },

    deleteTask(tasklist, task) {
      gate('deleteTask', [tasklist, task]);
      const t = requireTask(tasklist, task);
      t.deleted = true;
      t.deletedAt = serverMs();
      t.updated = serverNowIso();
      t.etag = etag();
      for (const child of descendants(t.id)) {
        const c = taskRows.find((x) => x.id === child)!;
        c.deleted = true;
        c.deletedAt = serverMs();
        c.updated = serverNowIso();
      }
      return Promise.resolve();
    },

    moveTask(tasklist, task, o: MoveTaskOptions) {
      gate('moveTask', [tasklist, task, o]);
      const t = requireTask(tasklist, task);
      const destList = o.destinationTasklist ?? tasklist;
      requireList(destList);
      if (o.parent) requireTask(destList, o.parent);
      if (destList !== t.listId) {
        order.set(t.listId, listOf(t.listId).filter((x) => x !== t.id));
        renumber(t.listId);
        t.listId = destList;
        for (const child of descendants(t.id)) {
          const c = taskRows.find((x) => x.id === child)!;
          order.set(c.listId, listOf(c.listId).filter((x) => x !== c.id));
          c.listId = destList;
        }
      }
      t.parent = o.parent ?? null;
      place(destList, t.id, t.parent, o.previous ?? null);
      t.updated = serverNowIso();
      t.etag = etag();
      return Promise.resolve(toGTask(t));
    },

    clearCompleted(tasklist) {
      gate('clearCompleted', [tasklist]);
      requireList(tasklist);
      // `clear` HIDES. hidden:true is not deleted:true.
      for (const t of taskRows) {
        if (t.listId !== tasklist || t.deleted || t.status !== 'completed' || t.hidden) continue;
        t.hidden = true;
        t.updated = serverNowIso();
        t.etag = etag();
      }
      return Promise.resolve();
    },

    // ---- control surface ----
    failNext(method, error, times = 1) {
      const q = failures.get(method) ?? [];
      for (let i = 0; i < times; i++) q.push(error);
      failures.set(method, q);
    },
    partition() {
      partitioned = true;
    },
    heal() {
      partitioned = false;
    },
    clearFailures() {
      failures.clear();
    },
    remoteEdit(taskId, patch) {
      const t = taskRows.find((x) => x.id === taskId);
      if (!t) throw new Error(`no such fake task ${taskId}`);
      Object.assign(t, patch);
      if (patch.due !== undefined) t.due = truncateDue(patch.due);
      if (patch.status === 'completed' && !t.completed) t.completed = serverNowIso();
      if (patch.status === 'needsAction') t.completed = null;
      t.updated = serverNowIso();
      t.etag = etag();
      return t;
    },
    remoteDelete(taskId) {
      const t = taskRows.find((x) => x.id === taskId);
      if (!t) throw new Error(`no such fake task ${taskId}`);
      t.deleted = true;
      t.deletedAt = serverMs();
      t.updated = serverNowIso();
      t.etag = etag();
    },
    remoteInsert(listId, init) {
      requireList(listId);
      return insertRow(listId, init, init.parent ?? null, null);
    },
    addList,
    calls: () => [...log],
    clearCalls: () => {
      log.length = 0;
    },
    lists: () => listRows.map((l) => ({ ...l })),
    tasks: () => taskRows.map((t) => ({ ...t })),
    task: (id) => {
      const t = taskRows.find((x) => x.id === id);
      return t ? { ...t } : undefined;
    },
    serverNowIso,
    setSkew(ms) {
      options.skewMs = ms;
    },
    setTombstonesInIncrementalPull(on) {
      options.tombstonesInIncrementalPull = on;
    },
  };

  return api;
}
