import type {
  AppInfo,
  AuthStatus,
  GithubLink,
  GithubSearchResult,
  GithubStatus,
  OutboxEntry,
  Settings,
  SyncState,
  Task,
  TaskCreateInput,
  TaskList,
  TaskMoveInput,
  TaskQueryInput,
  TaskUpdateInput,
  WindowBootstrap,
} from './models';

/**
 * Every renderer → main request/response pair. Adding a channel = one line
 * here + one entry in CHANNELS + one route in src/main/ipc/routes.ts.
 * The route map is typed as exhaustive, so forgetting one is a compile error.
 */
export interface IpcContract {
  'app:getInfo': { req: void; res: AppInfo };
  'app:getBootstrap': { req: void; res: WindowBootstrap };
  'app:openExternal': { req: { url: string }; res: void };
  'app:revealLogs': { req: void; res: void };
  'app:setZoom': { req: { delta: number } | { reset: true }; res: number };

  'auth:getStatus': { req: void; res: AuthStatus };
  'auth:setCredentials': { req: { clientId: string; clientSecret: string }; res: AuthStatus };
  'auth:clearCredentials': { req: void; res: AuthStatus };
  'auth:signIn': { req: void; res: AuthStatus };
  'auth:cancelSignIn': { req: void; res: AuthStatus };
  'auth:signOut': { req: { wipeLocalData: boolean }; res: AuthStatus };

  'lists:getAll': { req: void; res: TaskList[] };
  'lists:create': { req: { title: string; color?: string }; res: TaskList };
  'lists:update': { req: { id: string; title?: string; color?: string; isDefault?: boolean }; res: TaskList };
  'lists:reorder': { req: { orderedIds: string[] }; res: TaskList[] };
  'lists:delete': { req: { id: string }; res: void };

  'tasks:getAll': { req: void; res: Task[] };
  'tasks:get': { req: { id: string }; res: Task | null };
  'tasks:search': { req: TaskQueryInput; res: Task[] };
  'tasks:create': { req: TaskCreateInput; res: Task };
  'tasks:update': { req: TaskUpdateInput; res: Task };
  'tasks:setStatus': { req: { opId?: string; ids: string[]; completed: boolean }; res: Task[] };
  'tasks:move': { req: TaskMoveInput; res: Task };
  'tasks:delete': { req: { opId?: string; ids: string[] }; res: void };
  'tasks:restore': { req: { ids: string[] }; res: Task[] };
  'tasks:clearCompleted': { req: { listId: string }; res: void };
  'tasks:resolveConflict': { req: { id: string; resolution: 'keepLocal' | 'useServer' | 'restore' | 'discard' }; res: Task | null };

  'sync:now': { req: { full?: boolean } | void; res: SyncState };
  'sync:getState': { req: void; res: SyncState };
  'outbox:list': { req: void; res: OutboxEntry[] };
  'outbox:retry': { req: { id: string }; res: void };
  'outbox:retryAll': { req: void; res: void };
  'outbox:discard': { req: { id: string }; res: void };

  'settings:getAll': { req: void; res: Settings };
  'settings:set': { req: Partial<Settings>; res: Settings };

  'github:getStatus': { req: void; res: GithubStatus };
  'github:setToken': { req: { token: string }; res: GithubStatus };
  'github:clearToken': { req: void; res: GithubStatus };
  'github:link': { req: { taskId: string; url: string }; res: GithubLink };
  'github:unlink': { req: { taskId: string }; res: void };
  'github:refresh': { req: { taskId: string } | { all: true }; res: GithubLink[] };
  'github:search': { req: { q: string; limit?: number }; res: GithubSearchResult[] };

  'notifications:test': { req: void; res: { sent: boolean } };
  'notifications:openSystemSettings': { req: void; res: void };

  'window:quickAddSubmit': { req: TaskCreateInput & { keepOpen?: boolean }; res: Task };
  'window:hideQuickAdd': { req: void; res: void };
  'window:showMain': { req: { taskId?: string } | void; res: void };
  'window:resizeQuickAdd': { req: { height: number }; res: void };
}

export type Channel = keyof IpcContract;
export type Req<C extends Channel> = IpcContract[C]['req'];
export type Res<C extends Channel> = IpcContract[C]['res'];

export const CHANNELS = [
  'app:getInfo', 'app:getBootstrap', 'app:openExternal', 'app:revealLogs', 'app:setZoom',
  'auth:getStatus', 'auth:setCredentials', 'auth:clearCredentials', 'auth:signIn', 'auth:cancelSignIn', 'auth:signOut',
  'lists:getAll', 'lists:create', 'lists:update', 'lists:reorder', 'lists:delete',
  'tasks:getAll', 'tasks:get', 'tasks:search', 'tasks:create', 'tasks:update', 'tasks:setStatus', 'tasks:move',
  'tasks:delete', 'tasks:restore', 'tasks:clearCompleted', 'tasks:resolveConflict',
  'sync:now', 'sync:getState', 'outbox:list', 'outbox:retry', 'outbox:retryAll', 'outbox:discard',
  'settings:getAll', 'settings:set',
  'github:getStatus', 'github:setToken', 'github:clearToken', 'github:link', 'github:unlink', 'github:refresh', 'github:search',
  'notifications:test', 'notifications:openSystemSettings',
  'window:quickAddSubmit', 'window:hideQuickAdd', 'window:showMain', 'window:resizeQuickAdd',
] as const satisfies readonly Channel[];

// Compile-time completeness: errors if a contract key is missing from CHANNELS.
type MissingFromChannels = Exclude<Channel, (typeof CHANNELS)[number]>;
export const _channelsAreExhaustive: MissingFromChannels extends never ? true : never = true;
