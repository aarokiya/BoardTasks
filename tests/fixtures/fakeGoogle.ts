import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A real HTTP Google Tasks stand-in for E2E. The main process points at it via
 * BT_GOOGLE_BASE_URL, so the app under test makes genuine network calls
 * through its own client — including the OAuth token endpoint.
 *
 * It reproduces the same quirks as the in-memory fake (due truncated to
 * midnight UTC, parent/position ignored in bodies, clear sets hidden, delete
 * leaves a tombstone, opaque renumbered positions) plus control endpoints,
 * because offline E2E MUST use a control endpoint: network calls happen in the
 * main process, where Playwright's page-level `setOffline` has no effect.
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
}

export interface FakeGoogleState {
  lists: FakeTaskListRow[];
  tasks: FakeTaskRow[];
  order: Record<string, string[]>;
  offline: boolean;
  rateLimitUntil: number;
  skewMs: number;
  tombstonesInIncrementalPull: boolean;
  requests: Array<{ method: string; path: string; at: string }>;
  failures: Array<{ method: string; path?: string; status: number; times: number }>;
}

export interface FakeGoogleServer {
  url: string;
  stop(): Promise<void>;
  state: FakeGoogleState;
  /** Seed lists and tasks without going through HTTP. */
  seed(fixture: SeedFixture): void;
  reset(): void;
}

export interface SeedFixture {
  lists?: Array<{ id?: string; title: string }>;
  tasks?: Array<{
    id?: string;
    list: string;
    title: string;
    notes?: string;
    status?: 'needsAction' | 'completed';
    due?: string | null;
    parent?: string | null;
    hidden?: boolean;
  }>;
}

const JSON_TYPE = { 'content-type': 'application/json; charset=UTF-8' };

/** Request bodies are untrusted JSON: narrow, never String()-coerce. */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function pos(index: number): string {
  return String((index + 1) * 100_000).padStart(20, '0');
}

function truncateDue(due: string | null | undefined): string | null {
  if (!due) return null;
  return `${String(due).slice(0, 10)}T00:00:00.000Z`;
}

export async function startFakeGoogle(): Promise<FakeGoogleServer> {
  let ids = 0;
  const state: FakeGoogleState = {
    lists: [],
    tasks: [],
    order: {},
    offline: false,
    rateLimitUntil: 0,
    skewMs: 0,
    tombstonesInIncrementalPull: true,
    requests: [],
    failures: [],
  };

  const nextId = (p: string): string => `${p}${String(++ids).padStart(6, '0')}`;
  const serverMs = (): number => Date.now() + state.skewMs;
  const serverIso = (): string => new Date(serverMs()).toISOString();
  const etag = (): string => `"e${++ids}"`;

  function listOrder(listId: string): string[] {
    state.order[listId] ??= [];
    return state.order[listId];
  }

  function renumber(listId: string): void {
    const groups = new Map<string, number>();
    for (const id of listOrder(listId)) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) continue;
      const key = t.parent ?? '';
      const i = groups.get(key) ?? 0;
      groups.set(key, i + 1);
      t.position = pos(i);
    }
  }

  function place(listId: string, id: string, parent: string | null, previous: string | null): void {
    const without = listOrder(listId).filter((x) => x !== id);
    let at: number;
    if (previous) {
      const i = without.indexOf(previous);
      if (i < 0) at = without.length;
      else {
        at = i + 1;
        while (at < without.length) {
          const t = state.tasks.find((x) => x.id === without[at]);
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
    state.order[listId] = without;
    renumber(listId);
  }

  function addList(title: string, id?: string): FakeTaskListRow {
    const row: FakeTaskListRow = { id: id ?? nextId('L'), title, etag: etag(), updated: serverIso() };
    state.lists.push(row);
    state.order[row.id] = [];
    return row;
  }

  function addTask(listId: string, init: Partial<FakeTaskRow> & { title: string }, previous: string | null): FakeTaskRow {
    const row: FakeTaskRow = {
      id: init.id ?? nextId('T'),
      listId,
      title: init.title,
      notes: init.notes ?? '',
      status: init.status ?? 'needsAction',
      due: truncateDue(init.due ?? null),
      completed: init.status === 'completed' ? (init.completed ?? serverIso()) : null,
      deleted: false,
      hidden: init.hidden ?? false,
      parent: init.parent ?? null,
      position: pos(0),
      updated: serverIso(),
      etag: etag(),
    };
    state.tasks.push(row);
    place(listId, row.id, row.parent, previous);
    return row;
  }

  function taskJson(t: FakeTaskRow): Record<string, unknown> {
    const out: Record<string, unknown> = {
      kind: 'tasks#task',
      id: t.id,
      etag: t.etag,
      title: t.title,
      updated: t.updated,
      selfLink: `/tasks/v1/lists/${t.listId}/tasks/${t.id}`,
      position: t.position,
      status: t.status,
      webViewLink: `https://tasks.google.com/task/${t.id}`,
    };
    if (t.parent) out['parent'] = t.parent;
    if (t.notes) out['notes'] = t.notes;
    if (t.due) out['due'] = t.due;
    if (t.completed) out['completed'] = t.completed;
    if (t.deleted) out['deleted'] = true;
    if (t.hidden) out['hidden'] = true;
    return out;
  }

  function listJson(l: FakeTaskListRow): Record<string, unknown> {
    return { kind: 'tasks#taskList', id: l.id, etag: l.etag, title: l.title, updated: l.updated, selfLink: `/tasks/v1/users/@me/lists/${l.id}` };
  }

  function seed(fixture: SeedFixture): void {
    for (const l of fixture.lists ?? []) addList(l.title, l.id);
    for (const t of fixture.tasks ?? []) {
      const list = state.lists.find((l) => l.id === t.list || l.title === t.list);
      if (!list) throw new Error(`seed: unknown list ${t.list}`);
      addTask(list.id, { ...t, parent: t.parent ?? null }, null);
    }
  }

  function reset(): void {
    state.lists.length = 0;
    state.tasks.length = 0;
    state.order = {};
    state.offline = false;
    state.rateLimitUntil = 0;
    state.skewMs = 0;
    state.tombstonesInIncrementalPull = true;
    state.requests.length = 0;
    state.failures.length = 0;
    ids = 0;
    addList('My Tasks', 'L-default');
  }

  addList('My Tasks', 'L-default');

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { ...JSON_TYPE, date: new Date(serverMs()).toUTCString(), ...headers });
    res.end(payload);
  }

  function googleError(res: ServerResponse, status: number, reason: string, message: string, headers: Record<string, string> = {}): void {
    send(res, status, { error: { code: status, message, status: reason, errors: [{ domain: 'usageLimits', reason, message }] } }, headers);
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: { code: 500, message: 'fake server crashed' } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    state.requests.push({ method, path, at: serverIso() });

    // ---- control plane (never affected by offline/rate limits) ----
    if (path.startsWith('/__control/')) return control(req, res, path, method);

    if (state.offline) {
      req.destroy();
      res.destroy();
      return;
    }
    if (state.rateLimitUntil > Date.now()) {
      const secs = Math.ceil((state.rateLimitUntil - Date.now()) / 1000);
      return googleError(res, 429, 'rateLimitExceeded', 'Rate Limit Exceeded', { 'retry-after': String(secs) });
    }
    const failure = state.failures.find((f) => f.method === method && (!f.path || path.startsWith(f.path)) && f.times > 0);
    if (failure) {
      failure.times--;
      return googleError(res, failure.status, failure.status === 403 ? 'rateLimitExceeded' : 'backendError', 'Scripted failure');
    }

    // ---- OAuth ----
    if (path === '/oauth/token' && method === 'POST') {
      await readBody(req);
      return send(res, 200, {
        access_token: `ya29.fake-${++ids}`,
        refresh_token: '1//fake-refresh',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/tasks',
        token_type: 'Bearer',
      });
    }
    if (path === '/oauth/revoke') return send(res, 200, {});

    if (!req.headers.authorization && path.startsWith('/tasks/v1/')) {
      return googleError(res, 401, 'authError', 'Invalid Credentials');
    }

    // ---- tasklists ----
    if (path === '/tasks/v1/users/@me/lists') {
      if (method === 'GET') return send(res, 200, { kind: 'tasks#taskLists', items: state.lists.map(listJson) });
      if (method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, listJson(addList(str(body['title']))));
      }
      return googleError(res, 405, 'notImplemented', 'Method not allowed');
    }

    const listMatch = /^\/tasks\/v1\/users\/@me\/lists\/([^/]+)$/.exec(path);
    if (listMatch) {
      const id = decodeURIComponent(listMatch[1]!);
      const list = state.lists.find((l) => l.id === id);
      if (!list) return googleError(res, 404, 'notFound', 'Task list not found');
      if (method === 'GET') return send(res, 200, listJson(list));
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readBody(req);
        if (body['title'] !== undefined) list.title = str(body['title'], list.title);
        list.updated = serverIso();
        list.etag = etag();
        return send(res, 200, listJson(list));
      }
      if (method === 'DELETE') {
        state.lists.splice(state.lists.indexOf(list), 1);
        state.tasks = state.tasks.filter((t) => t.listId !== id);
        delete state.order[id];
        return send(res, 204, undefined);
      }
    }

    // ---- tasks ----
    const tasksMatch = /^\/tasks\/v1\/lists\/([^/]+)\/tasks$/.exec(path);
    if (tasksMatch) {
      const listId = decodeURIComponent(tasksMatch[1]!);
      if (!state.lists.some((l) => l.id === listId)) return googleError(res, 404, 'notFound', 'Task list not found');
      if (method === 'GET') return send(res, 200, listTasks(listId, url));
      if (method === 'POST') {
        const body = await readBody(req);
        const parent = url.searchParams.get('parent');
        const previous = url.searchParams.get('previous');
        // parent/position in the body are ignored, exactly like the real API.
        const row = addTask(
          listId,
          {
            title: str(body['title']),
            notes: str(body['notes']),
            status: body['status'] === 'completed' ? 'completed' : 'needsAction',
            due: nullableStr(body['due']),
            completed: nullableStr(body['completed']),
            parent,
          },
          previous,
        );
        return send(res, 200, taskJson(row));
      }
    }

    const taskMatch = /^\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch) {
      const listId = decodeURIComponent(taskMatch[1]!);
      const taskId = decodeURIComponent(taskMatch[2]!);
      const t = state.tasks.find((x) => x.id === taskId && x.listId === listId);
      if (!t) return googleError(res, 404, 'notFound', 'Task not found');
      if (method === 'GET') return send(res, 200, taskJson(t));
      if (method === 'PATCH' || method === 'PUT') {
        const ifMatch = req.headers['if-match'];
        if (typeof ifMatch === 'string' && ifMatch !== t.etag) return googleError(res, 412, 'conditionNotMet', 'Precondition Failed');
        const body = await readBody(req);
        if (body['title'] !== undefined) t.title = str(body['title'], t.title);
        if (body['notes'] !== undefined) t.notes = str(body['notes']);
        if (body['due'] !== undefined) t.due = truncateDue(nullableStr(body['due']));
        if (body['status'] !== undefined) {
          t.status = body['status'] === 'completed' ? 'completed' : 'needsAction';
          t.completed = t.status === 'completed' ? str(body['completed'], serverIso()) : null;
          if (t.status === 'needsAction') t.hidden = false;
        }
        t.updated = serverIso();
        t.etag = etag();
        return send(res, 200, taskJson(t));
      }
      if (method === 'DELETE') {
        t.deleted = true;
        t.updated = serverIso();
        t.etag = etag();
        for (const c of state.tasks.filter((x) => x.parent === t.id)) {
          c.deleted = true;
          c.updated = serverIso();
        }
        return send(res, 204, undefined);
      }
    }

    const moveMatch = /^\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)\/move$/.exec(path);
    if (moveMatch && method === 'POST') {
      const listId = decodeURIComponent(moveMatch[1]!);
      const taskId = decodeURIComponent(moveMatch[2]!);
      const t = state.tasks.find((x) => x.id === taskId && x.listId === listId);
      if (!t) return googleError(res, 404, 'notFound', 'Task not found');
      const dest = url.searchParams.get('destinationTasklist') ?? listId;
      if (!state.lists.some((l) => l.id === dest)) return googleError(res, 404, 'notFound', 'Task list not found');
      if (dest !== t.listId) {
        state.order[t.listId] = listOrder(t.listId).filter((x) => x !== t.id);
        renumber(t.listId);
        for (const c of state.tasks.filter((x) => x.parent === t.id)) {
          state.order[c.listId] = listOrder(c.listId).filter((x) => x !== c.id);
          c.listId = dest;
        }
        t.listId = dest;
      }
      t.parent = url.searchParams.get('parent');
      place(dest, t.id, t.parent, url.searchParams.get('previous'));
      t.updated = serverIso();
      t.etag = etag();
      return send(res, 200, taskJson(t));
    }

    const clearMatch = /^\/tasks\/v1\/lists\/([^/]+)\/clear$/.exec(path);
    if (clearMatch && method === 'POST') {
      const listId = decodeURIComponent(clearMatch[1]!);
      if (!state.lists.some((l) => l.id === listId)) return googleError(res, 404, 'notFound', 'Task list not found');
      for (const t of state.tasks) {
        if (t.listId !== listId || t.deleted || t.status !== 'completed' || t.hidden) continue;
        t.hidden = true; // clear HIDES; it does not delete
        t.updated = serverIso();
        t.etag = etag();
      }
      return send(res, 204, undefined);
    }

    return googleError(res, 404, 'notFound', `No fake route for ${method} ${path}`);
  }

  function listTasks(listId: string, url: URL): Record<string, unknown> {
    const q = url.searchParams;
    const updatedMin = q.get('updatedMin');
    const showDeleted = q.get('showDeleted') === 'true';
    const showHidden = q.get('showHidden') === 'true';
    const showCompleted = q.get('showCompleted') !== 'false';
    const maxResults = Number(q.get('maxResults') ?? '20');
    const offset = Number(q.get('pageToken') ?? '0');

    const ordered = listOrder(listId)
      .map((id) => state.tasks.find((t) => t.id === id))
      .filter((t): t is FakeTaskRow => t !== undefined);

    const filtered = ordered.filter((t) => {
      if (updatedMin && t.updated < updatedMin) return false;
      if (t.deleted) {
        if (!showDeleted) return false;
        if (updatedMin && !state.tombstonesInIncrementalPull) return false;
        return true;
      }
      if (t.hidden && !showHidden) return false;
      if (t.status === 'completed' && !showCompleted) return false;
      return true;
    });

    const slice = filtered.slice(offset, offset + maxResults);
    const out: Record<string, unknown> = { kind: 'tasks#tasks', items: slice.map(taskJson) };
    if (offset + maxResults < filtered.length) out['nextPageToken'] = String(offset + maxResults);
    return out;
  }

  async function control(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    const body = method === 'POST' ? await readBody(req) : {};
    switch (path) {
      case '/__control/offline':
        state.offline = true;
        return send(res, 200, { offline: true });
      case '/__control/online':
        state.offline = false;
        return send(res, 200, { offline: false });
      case '/__control/fail-next':
        state.failures.push({
          method: str(body['method'], 'GET').toUpperCase(),
          path: typeof body['path'] === 'string' ? body['path'] : undefined,
          status: num(body['status'], 500),
          times: num(body['times'], 1),
        });
        return send(res, 200, { ok: true });
      case '/__control/rate-limit':
        state.rateLimitUntil = Date.now() + num(body['seconds'], 1) * 1000;
        return send(res, 200, { until: state.rateLimitUntil });
      case '/__control/skew':
        state.skewMs = num(body['ms'], 0);
        return send(res, 200, { skewMs: state.skewMs });
      case '/__control/tombstones':
        state.tombstonesInIncrementalPull = body['enabled'] !== false;
        return send(res, 200, { tombstonesInIncrementalPull: state.tombstonesInIncrementalPull });
      case '/__control/mutate': {
        // An edit from another device.
        const t = state.tasks.find((x) => x.id === str(body['taskId']) && (!body['listId'] || x.listId === str(body['listId'])));
        if (!t) return send(res, 404, { error: 'no such task' });
        const patch = (body['patch'] ?? {}) as Record<string, unknown>;
        if (patch['title'] !== undefined) t.title = str(patch['title'], t.title);
        if (patch['notes'] !== undefined) t.notes = str(patch['notes'], t.notes);
        if (patch['due'] !== undefined) t.due = truncateDue(nullableStr(patch['due']));
        if (patch['status'] !== undefined) {
          t.status = patch['status'] === 'completed' ? 'completed' : 'needsAction';
          t.completed = t.status === 'completed' ? serverIso() : null;
        }
        t.updated = serverIso();
        t.etag = etag();
        return send(res, 200, taskJson(t));
      }
      case '/__control/delete': {
        const t = state.tasks.find((x) => x.id === str(body['taskId']));
        if (!t) return send(res, 404, { error: 'no such task' });
        t.deleted = true;
        t.updated = serverIso();
        t.etag = etag();
        return send(res, 200, taskJson(t));
      }
      case '/__control/seed':
        seed(body);
        return send(res, 200, { ok: true });
      case '/__control/state':
        return send(res, 200, { lists: state.lists, tasks: state.tasks, order: state.order, requests: state.requests });
      case '/__control/reset':
        reset();
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: `unknown control endpoint ${path}` });
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    state,
    seed,
    reset,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
