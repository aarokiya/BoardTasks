import { vi } from 'vitest';
import type { Channel, IpcContract, Req, Res } from '@shared/ipc';
import type { MainEvent } from '@shared/events';
import type { Result } from '@shared/result';
import { DEFAULT_SETTINGS, type AuthStatus, type GithubStatus, type Settings, type SyncState, type Task, type TaskList } from '@shared/models';
import type { BoardTasksBridge } from '../../src/preload/index.d';

type Handlers = { [C in Channel]: (req: Req<C>) => Res<C> | Promise<Res<C>> };

export interface MockSeed {
  tasks?: Partial<Task>[];
  lists?: Partial<TaskList>[];
  auth?: Partial<AuthStatus>;
  sync?: Partial<SyncState>;
  settings?: Partial<Settings>;
}

let seq = 0;
const nid = (): string => `id-${++seq}`;

export function makeList(p: Partial<TaskList> = {}): TaskList {
  return { id: nid(), remoteId: null, title: 'Inbox', color: 'blue', position: 0, isDefault: true, sync: 'synced', rev: 1, updatedAt: null, ...p };
}

export function makeTask(p: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: nid(), remoteId: null, listId: 'list-1', title: 'Task', notes: '', status: 'needsAction', due: null, dueTime: null,
    completedAt: null, parentId: null, sortKey: `V${String(++seq).padStart(4, '0')}`, priority: 0, flagged: false, hidden: false,
    deleted: false, webViewLink: null, links: [], github: null, sync: 'synced', conflict: null, rev: 1, createdAt: now,
    updatedAt: null, localUpdatedAt: now, ...p,
  };
}

export interface MockApi extends BoardTasksBridge {
  state: { tasks: Map<string, Task>; lists: Map<string, TaskList>; auth: AuthStatus; sync: SyncState; settings: Settings; github: GithubStatus };
  handlers: Handlers;
  calls: Array<{ channel: Channel; payload: unknown }>;
  /** Push an event as if main sent it. */
  emit(e: MainEvent): void;
  /** Override a handler for one test. */
  stub<C extends Channel>(channel: C, fn: Handlers[C]): void;
  /** Make the next call to `channel` fail with an IPC error. */
  failNext(channel: Channel, error?: Partial<Extract<Result<never>, { ok: false }>['error']>): void;
}

export function createMockApi(seed: MockSeed = {}): MockApi {
  const lists = new Map<string, TaskList>();
  const tasks = new Map<string, Task>();
  const seededLists = seed.lists?.length ? seed.lists.map((l) => makeList(l)) : [makeList({ id: 'list-1', title: 'Inbox' })];
  for (const l of seededLists) lists.set(l.id, l);
  for (const t of seed.tasks ?? []) {
    const task = makeTask({ listId: seededLists[0]!.id, ...t });
    tasks.set(task.id, task);
  }
  const state: MockApi['state'] = {
    tasks, lists,
    auth: { state: 'signed_in', clientIdHint: 'abc', account: { email: 'e2e@test', name: 'Test' }, reason: null, signedInAt: new Date().toISOString(), ...seed.auth },
    sync: { status: 'idle', online: true, lastSyncStartedAt: null, lastSyncSucceededAt: new Date().toISOString(), pendingCount: 0, failedCount: 0, conflictCount: 0, errorMessage: null, retryAfterMs: null, ...seed.sync },
    settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, ...seed.settings },
    github: { connected: false, login: null, tokenHint: null, scopes: [], rateLimitRemaining: null, rateLimitResetAt: null, error: null },
  };
  const listeners = new Set<(e: MainEvent) => void>();
  const emit = (e: MainEvent): void => { for (const l of listeners) l(e); };
  const bump = (t: Task): Task => { const n = { ...t, rev: t.rev + 1, localUpdatedAt: new Date().toISOString() }; tasks.set(n.id, n); return n; };
  const failures = new Map<Channel, NonNullable<Parameters<MockApi['failNext']>[1]>>();

  const handlers: Handlers = {
    'app:getInfo': () => ({ version: '0.0.0-test', electron: '0', platform: 'darwin', isPackaged: false, userDataPath: '/tmp', logPath: '/tmp/main.log', e2e: true }),
    'app:getBootstrap': () => ({ window: 'main', theme: 'light', themePreference: 'system', platform: 'darwin' }),
    'app:openExternal': () => undefined,
    'app:revealLogs': () => undefined,
    'app:setZoom': () => 0,
    'auth:getStatus': () => state.auth,
    'auth:setCredentials': () => (state.auth = { ...state.auth, state: 'signed_out', clientIdHint: 'set' }),
    'auth:clearCredentials': () => (state.auth = { ...state.auth, state: 'no_credentials', clientIdHint: null }),
    'auth:signIn': () => (state.auth = { ...state.auth, state: 'signed_in' }),
    'auth:cancelSignIn': () => state.auth,
    'auth:signOut': () => (state.auth = { ...state.auth, state: 'signed_out', account: null }),
    'lists:getAll': () => [...lists.values()],
    'lists:create': (p) => { const l = makeList({ title: p.title, color: (p.color as TaskList['color']) ?? 'gray', isDefault: false, position: lists.size }); lists.set(l.id, l); return l; },
    'lists:update': (p) => { const l = { ...lists.get(p.id)!, ...(p.title !== undefined ? { title: p.title } : {}), ...(p.color ? { color: p.color as TaskList['color'] } : {}) }; l.rev++; lists.set(l.id, l); return l; },
    'lists:reorder': (p) => { p.orderedIds.forEach((id, i) => { const l = lists.get(id); if (l) lists.set(id, { ...l, position: i }); }); return [...lists.values()]; },
    'lists:delete': (p) => { lists.delete(p.id); for (const t of [...tasks.values()]) if (t.listId === p.id) tasks.delete(t.id); },
    'tasks:getAll': () => [...tasks.values()],
    'tasks:get': (p) => tasks.get(p.id) ?? null,
    'tasks:search': (p) => [...tasks.values()].filter((t) => t.title.toLowerCase().includes(p.q.toLowerCase())),
    'tasks:create': (p) => { const t = makeTask({ listId: p.listId ?? seededLists[0]!.id, title: p.title, notes: p.notes ?? '', due: p.due ?? null, dueTime: p.dueTime ?? null, parentId: p.parentId ?? null, priority: p.priority ?? 0, flagged: p.flagged ?? false, sync: 'pending' }); tasks.set(t.id, t); return t; },
    'tasks:update': (p) => { const cur = tasks.get(p.id); if (!cur) throw new Error('not found'); const completedAt = p.patch.status ? (p.patch.status === 'completed' ? new Date().toISOString() : null) : cur.completedAt; return bump({ ...cur, ...p.patch, completedAt }); },
    'tasks:setStatus': (p) => p.ids.map((id) => bump({ ...tasks.get(id)!, status: p.completed ? 'completed' : 'needsAction', completedAt: p.completed ? new Date().toISOString() : null })),
    'tasks:move': (p) => bump({ ...tasks.get(p.id)!, parentId: p.parentId, listId: p.listId ?? tasks.get(p.id)!.listId }),
    'tasks:delete': (p) => { for (const id of p.ids) { for (const t of [...tasks.values()]) if (t.parentId === id) tasks.delete(t.id); tasks.delete(id); } },
    'tasks:restore': (p) => p.ids.map((id) => tasks.get(id)).filter((t): t is Task => !!t),
    'tasks:clearCompleted': () => undefined,
    'tasks:resolveConflict': (p) => { const t = tasks.get(p.id); if (!t) return null; return bump({ ...t, conflict: null, sync: 'synced' }); },
    'sync:now': () => state.sync,
    'sync:getState': () => state.sync,
    'outbox:list': () => [],
    'outbox:retry': () => undefined,
    'outbox:retryAll': () => undefined,
    'outbox:discard': () => undefined,
    'settings:getAll': () => state.settings,
    'settings:set': (p) => { state.settings = { ...state.settings, ...p }; emit({ type: 'settings:changed', settings: state.settings }); return state.settings; },
    'github:getStatus': () => state.github,
    'github:setToken': () => (state.github = { ...state.github, connected: true, login: 'octocat', tokenHint: '…1234' }),
    'github:clearToken': () => (state.github = { ...state.github, connected: false, login: null, tokenHint: null }),
    'github:link': (p) => ({ id: nid(), taskId: p.taskId, url: p.url, host: 'github.com', owner: 'o', repo: 'r', type: 'issue', number: 1, title: 'Issue', state: 'open', author: 'octocat', authorAvatarUrl: null, labels: [], checks: null, reviewDecision: null, remoteUpdatedAt: null, fetchedAt: new Date().toISOString(), error: null, createdAt: new Date().toISOString() }),
    'github:unlink': () => undefined,
    'github:refresh': () => [],
    'github:search': () => [],
    'notifications:test': () => ({ sent: true }),
    'notifications:openSystemSettings': () => undefined,
    'window:quickAddSubmit': (p) => handlers['tasks:create'](p),
    'window:hideQuickAdd': () => undefined,
    'window:showMain': () => undefined,
    'window:resizeQuickAdd': () => undefined,
  };

  const calls: MockApi['calls'] = [];
  const api: MockApi = {
    state, handlers, calls, emit,
    stub: (channel, fn) => { (handlers as Record<string, unknown>)[channel] = fn; },
    failNext: (channel, error) => { failures.set(channel, error ?? {}); },
    boot: { window: 'main', theme: 'light', themePreference: 'system', platform: 'darwin', e2e: true },
    invoke: vi.fn(async (channel: Channel, payload?: unknown): Promise<Result<unknown>> => {
      calls.push({ channel, payload });
      const fail = failures.get(channel);
      if (fail) {
        failures.delete(channel);
        return { ok: false, error: { code: 'INTERNAL', message: 'Simulated failure', retryable: false, traceId: 'mock', ...fail } };
      }
      try {
        const h = handlers[channel] as (req: unknown) => unknown;
        return { ok: true, data: await h(payload) };
      } catch (e) {
        return { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), retryable: false, traceId: 'mock' } };
      }
    }),
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
  return api;
}

/** Install as window.boardtasks for the current test. */
export function installMockApi(seed?: MockSeed): MockApi {
  const api = createMockApi(seed);
  Object.defineProperty(window, 'boardtasks', { value: api, configurable: true, writable: true });
  return api;
}

// Type-level guard: every contract key has a handler with the right shape.
type _Check = Handlers extends { [C in keyof IpcContract]: unknown } ? true : never;
export const _handlersCoverContract: _Check = true;
