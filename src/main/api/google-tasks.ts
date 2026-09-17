import { GOOGLE_TASKS_BASE_URL } from '@shared/constants';
import type { HttpClient, QueryValue, RequestSpec } from './http-client';
import {
  gTaskListSchema,
  gTaskListsPageSchema,
  gTaskSchema,
  gTasksPageSchema,
  parseOrThrow,
  type GTask,
  type GTaskList,
  type TaskWriteBody,
} from './schemas';

/**
 * The whole Google Tasks surface BoardTasks uses: two resources, nine calls.
 * (This is why `googleapis` — 300MB of generated clients — is not a dependency.)
 */

export interface ListTasksParams {
  tasklist: string;
  /** RFC3339. Only items updated at/after this instant. Omit for a full pull. */
  updatedMin?: string;
  showCompleted?: boolean;
  showHidden?: boolean;
  showDeleted?: boolean;
  showAssigned?: boolean;
  maxResults?: number;
  pageToken?: string;
  dueMin?: string;
  dueMax?: string;
}

export interface Page<T> {
  items: T[];
  nextPageToken: string | null;
  /** The HTTP `Date` header of the response that produced this page. */
  serverDate: string | null;
}

export interface InsertTaskOptions {
  /** Remote id of the parent task. Hierarchy can ONLY be set this way. */
  parent?: string;
  /** Remote id of the sibling to insert after. Omit = first. */
  previous?: string;
}

export interface MoveTaskOptions {
  parent?: string;
  previous?: string;
  destinationTasklist?: string;
}

export interface GoogleTasksApi {
  listTaskLists(pageToken?: string): Promise<Page<GTaskList>>;
  insertTaskList(body: { title: string }): Promise<GTaskList>;
  patchTaskList(tasklist: string, body: { title: string }): Promise<GTaskList>;
  deleteTaskList(tasklist: string): Promise<void>;

  listTasks(params: ListTasksParams): Promise<Page<GTask>>;
  insertTask(tasklist: string, body: TaskWriteBody, opts?: InsertTaskOptions): Promise<GTask>;
  patchTask(tasklist: string, task: string, body: TaskWriteBody, etag?: string | null): Promise<GTask>;
  deleteTask(tasklist: string, task: string): Promise<void>;
  moveTask(tasklist: string, task: string, opts: MoveTaskOptions): Promise<GTask>;
  clearCompleted(tasklist: string): Promise<void>;
}

/** tasks.list defaults to maxResults=20 — a 500-task list would be 25 round trips. */
export const PAGE_SIZE = 100;

/**
 * Where to send requests. The fake server (E2E) is pointed at by
 * BT_GOOGLE_BASE_URL and serves the real path shape under its own origin, so
 * the override appends `/tasks/v1` while the production constant already
 * contains it.
 *
 * Read from process.env directly rather than src/main/env.ts: that module
 * imports `electron` at load time and this one must stay importable in a
 * plain node unit test.
 */
export function resolveBaseUrl(override?: string | null): string {
  const base = override ?? process.env['BT_GOOGLE_BASE_URL'] ?? null;
  if (!base) return GOOGLE_TASKS_BASE_URL;
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/tasks/v1`;
}

const enc = encodeURIComponent;

export function createGoogleTasksApi(http: HttpClient): GoogleTasksApi {
  async function call(spec: RequestSpec): Promise<{ data: unknown; serverDate: string | null }> {
    const r = await http.request(spec);
    return { data: r.data, serverDate: r.serverDate };
  }

  return {
    async listTaskLists(pageToken) {
      const { data, serverDate } = await call({
        method: 'GET',
        path: '/users/@me/lists',
        query: { maxResults: 100, pageToken },
        idempotent: true,
        label: 'tasklists.list',
      });
      const page = parseOrThrow(gTaskListsPageSchema, data ?? {}, 'tasklists.list');
      return { items: page.items ?? [], nextPageToken: page.nextPageToken ?? null, serverDate };
    },

    async insertTaskList(body) {
      // Creating a list is not idempotent either, but unlike tasks.insert a
      // duplicate list is caught by the adoption pass on the next pull.
      const { data } = await call({ method: 'POST', path: '/users/@me/lists', body, idempotent: false, label: 'tasklists.insert' });
      return parseOrThrow(gTaskListSchema, data, 'tasklists.insert');
    },

    async patchTaskList(tasklist, body) {
      const { data } = await call({ method: 'PATCH', path: `/users/@me/lists/${enc(tasklist)}`, body, idempotent: true, label: 'tasklists.patch' });
      return parseOrThrow(gTaskListSchema, data, 'tasklists.patch');
    },

    async deleteTaskList(tasklist) {
      await call({ method: 'DELETE', path: `/users/@me/lists/${enc(tasklist)}`, idempotent: true, label: 'tasklists.delete' });
    },

    async listTasks(params) {
      // All four show* flags are ALWAYS explicit: Google's own docs contradict
      // each other on the showHidden default, so relying on it is a coin flip.
      const query: Record<string, QueryValue> = {
        maxResults: params.maxResults ?? PAGE_SIZE,
        showCompleted: params.showCompleted ?? true,
        showHidden: params.showHidden ?? true,
        showDeleted: params.showDeleted ?? true,
        showAssigned: params.showAssigned ?? true,
        updatedMin: params.updatedMin,
        pageToken: params.pageToken,
        dueMin: params.dueMin,
        dueMax: params.dueMax,
      };
      const { data, serverDate } = await call({
        method: 'GET',
        path: `/lists/${enc(params.tasklist)}/tasks`,
        query,
        idempotent: true,
        label: 'tasks.list',
      });
      const page = parseOrThrow(gTasksPageSchema, data ?? {}, 'tasks.list');
      return { items: page.items ?? [], nextPageToken: page.nextPageToken ?? null, serverDate };
    },

    async insertTask(tasklist, body, opts) {
      // idempotent: false. A lost 500 might mean the task WAS created; the
      // outbox owns the retry and the next pull reconciles duplicates.
      const { data } = await call({
        method: 'POST',
        path: `/lists/${enc(tasklist)}/tasks`,
        query: { parent: opts?.parent, previous: opts?.previous },
        body,
        idempotent: false,
        label: 'tasks.insert',
      });
      return parseOrThrow(gTaskSchema, data, 'tasks.insert');
    },

    async patchTask(tasklist, task, body, etag) {
      const { data } = await call({
        method: 'PATCH',
        path: `/lists/${enc(tasklist)}/tasks/${enc(task)}`,
        body,
        idempotent: true,
        headers: etag ? { 'if-match': etag } : undefined,
        label: 'tasks.patch',
      });
      return parseOrThrow(gTaskSchema, data, 'tasks.patch');
    },

    async deleteTask(tasklist, task) {
      await call({ method: 'DELETE', path: `/lists/${enc(tasklist)}/tasks/${enc(task)}`, idempotent: true, label: 'tasks.delete' });
    },

    async moveTask(tasklist, task, opts) {
      const { data } = await call({
        method: 'POST',
        path: `/lists/${enc(tasklist)}/tasks/${enc(task)}/move`,
        query: { parent: opts.parent, previous: opts.previous, destinationTasklist: opts.destinationTasklist },
        idempotent: true,
        label: 'tasks.move',
      });
      return parseOrThrow(gTaskSchema, data, 'tasks.move');
    },

    async clearCompleted(tasklist) {
      await call({ method: 'POST', path: `/lists/${enc(tasklist)}/clear`, idempotent: true, label: 'tasks.clear' });
    },
  };
}
