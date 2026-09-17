import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { AuthStatus, Settings, SyncState, Task, TaskCreateInput, TaskList, TaskMoveInput, TaskUpdateInput, Density } from '@shared/models';
import type { MainEvent } from '@shared/events';
import type { ViewId } from '@shared/constants';
import { todayCivil, type CivilDate } from '@shared/date/civil';
import { call, onMainEvent } from '../lib/ipc';

export type OverlayKind = 'palette' | 'shortcuts' | 'settings' | 'outbox' | 'onboarding' | 'github-picker' | 'list-picker' | 'date-picker' | null;

export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  timeoutMs?: number;
}

export interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export interface State {
  hydrated: boolean;
  tasks: Record<string, Task>;
  lists: Record<string, TaskList>;
  /** Bumps on every entity change; selectors memoize on it. */
  version: number;
  auth: AuthStatus | null;
  sync: SyncState | null;
  settings: Settings | null;
  online: boolean;
  today: CivilDate;
  windowFocused: boolean;

  view: ViewId;
  selection: string[];
  anchorId: string | null;
  focusId: string | null;
  editingId: string | null;
  dragging: boolean;
  filterQuery: string;
  overlay: OverlayKind;
  overlayPayload: unknown;
  sidebarWidth: number;
  sidebarUserCollapsed: boolean;
  sidebarAutoCollapsed: boolean;
  detailWidth: number;
  inspectorOpen: boolean;
  density: Density;
  showCompletedByList: Record<string, boolean>;
  collapsedParents: Record<string, true>;
  toasts: Toast[];
  undoPast: UndoEntry[];
  undoFuture: UndoEntry[];
  bufferedEvents: MainEvent[];
}

export interface Actions {
  hydrate: () => Promise<void>;
  applyEvent: (e: MainEvent) => void;
  refreshToday: () => void;

  setView: (v: ViewId) => void;
  select: (ids: string[], anchorId?: string | null) => void;
  setFocus: (id: string | null) => void;
  setEditing: (id: string | null) => void;
  setDragging: (d: boolean) => void;
  setFilter: (q: string) => void;
  openOverlay: (k: OverlayKind, payload?: unknown) => void;
  closeOverlay: () => void;
  setUi: (patch: Partial<Pick<State, 'sidebarWidth' | 'sidebarUserCollapsed' | 'sidebarAutoCollapsed' | 'detailWidth' | 'inspectorOpen' | 'density'>>) => void;
  toggleShowCompleted: (listId: string) => void;
  toggleCollapsed: (parentId: string) => void;

  toast: (t: Omit<Toast, 'id'>) => string;
  dismissToast: (id: string) => void;
  pushUndo: (e: UndoEntry) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  // Optimistic mutations. Each applies locally, calls main, then installs the authoritative entity.
  createTask: (input: TaskCreateInput) => Promise<Task>;
  updateTask: (id: string, patch: TaskUpdateInput['patch']) => Promise<Task>;
  setStatus: (ids: string[], completed: boolean) => Promise<Task[]>;
  moveTask: (input: TaskMoveInput) => Promise<Task>;
  deleteTasks: (ids: string[]) => Promise<void>;
  restoreTasks: (ids: string[]) => Promise<Task[]>;
}

export type Store = State & Actions;

const UI_KEY = 'bt.ui.v1';
type PersistedUi = Partial<Pick<State, 'view' | 'sidebarWidth' | 'sidebarUserCollapsed' | 'detailWidth' | 'inspectorOpen' | 'density' | 'showCompletedByList' | 'collapsedParents'>>;

function loadUi(): PersistedUi {
  try {
    const raw = localStorage.getItem(UI_KEY);
    return raw ? (JSON.parse(raw) as PersistedUi) : {};
  } catch {
    return {};
  }
}
function saveUi(s: State): void {
  try {
    const p: PersistedUi = { view: s.view, sidebarWidth: s.sidebarWidth, sidebarUserCollapsed: s.sidebarUserCollapsed, detailWidth: s.detailWidth, inspectorOpen: s.inspectorOpen, density: s.density, showCompletedByList: s.showCompletedByList, collapsedParents: s.collapsedParents };
    localStorage.setItem(UI_KEY, JSON.stringify(p));
  } catch {
    /* private mode etc. */
  }
}

let toastSeq = 0;

export const useStore = create<Store>()(
  subscribeWithSelector((set, get) => {
    const ui = loadUi();

    const installTasks = (tasks: Task[], deleted: string[] = []): void =>
      set((s) => {
        const next = { ...s.tasks };
        let changed = false;
        for (const t of tasks) {
          const cur = next[t.id];
          if (cur && t.rev < cur.rev) continue;
          if (t.deleted) {
            if (cur) { delete next[t.id]; changed = true; }
            continue;
          }
          next[t.id] = t;
          changed = true;
        }
        for (const id of deleted) if (next[id]) { delete next[id]; changed = true; }
        if (!changed) return {};
        const selection = s.selection.filter((id) => next[id]);
        const focusId = s.focusId && next[s.focusId] ? s.focusId : null;
        return { tasks: next, version: s.version + 1, selection, focusId: focusId ?? (selection[0] ?? null) };
      });

    const installLists = (lists: TaskList[], deleted: string[] = []): void =>
      set((s) => {
        const next = { ...s.lists };
        for (const l of lists) {
          const cur = next[l.id];
          if (cur && l.rev < cur.rev) continue;
          next[l.id] = l;
        }
        for (const id of deleted) delete next[id];
        return { lists: next, version: s.version + 1 };
      });

    const patchLocal = (id: string, patch: Partial<Task>): void =>
      set((s) => {
        const cur = s.tasks[id];
        if (!cur) return {};
        return { tasks: { ...s.tasks, [id]: { ...cur, ...patch } }, version: s.version + 1 };
      });

    return {
      hydrated: false,
      tasks: {},
      lists: {},
      version: 0,
      auth: null,
      sync: null,
      settings: null,
      online: true,
      today: todayCivil(),
      windowFocused: true,
      view: ui.view ?? 'today',
      selection: [],
      anchorId: null,
      focusId: null,
      editingId: null,
      dragging: false,
      filterQuery: '',
      overlay: null,
      overlayPayload: null,
      sidebarWidth: ui.sidebarWidth ?? 248,
      sidebarUserCollapsed: ui.sidebarUserCollapsed ?? false,
      sidebarAutoCollapsed: false,
      detailWidth: ui.detailWidth ?? 360,
      inspectorOpen: ui.inspectorOpen ?? true,
      density: ui.density ?? 'default',
      showCompletedByList: ui.showCompletedByList ?? {},
      collapsedParents: ui.collapsedParents ?? {},
      toasts: [],
      undoPast: [],
      undoFuture: [],
      bufferedEvents: [],

      async hydrate() {
        const [tasks, lists, auth, sync, settings] = await Promise.all([
          call('tasks:getAll'), call('lists:getAll'), call('auth:getStatus').catch(() => null), call('sync:getState').catch(() => null), call('settings:getAll').catch(() => null),
        ]);
        set({
          tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
          lists: Object.fromEntries(lists.map((l) => [l.id, l])),
          auth, sync, settings, hydrated: true, today: todayCivil(),
          online: sync?.online ?? true,
          density: settings?.density ?? get().density,
        });
        set((s) => ({ version: s.version + 1 }));
      },

      applyEvent(e) {
        const s = get();
        if (s.dragging && e.type === 'data:changed') {
          set({ bufferedEvents: [...s.bufferedEvents, e] });
          return;
        }
        switch (e.type) {
          case 'data:changed':
            installLists(e.lists, e.deletedListIds);
            installTasks(e.tasks, e.deletedTaskIds);
            break;
          case 'auth:changed': set({ auth: e.status }); break;
          case 'sync:state': set({ sync: e.state, online: e.state.online }); break;
          case 'settings:changed': set({ settings: e.settings, density: e.settings.density }); break;
          case 'net:status': set({ online: e.online }); break;
          case 'system:resume': get().refreshToday(); break;
          case 'window:focus': set({ windowFocused: e.focused }); if (e.focused) get().refreshToday(); break;
          case 'navigate': set({ view: e.view as ViewId }); break;
          case 'focusTask': {
            const t = get().tasks[e.taskId];
            if (t) set({ view: `list:${t.listId}`, selection: [t.id], focusId: t.id, inspectorOpen: true });
            break;
          }
          case 'toast': get().toast({ level: e.level, message: e.message, actionLabel: e.actionLabel, onAction: e.actionCommand ? () => window.dispatchEvent(new CustomEvent('bt:command', { detail: e.actionCommand })) : undefined });
            break;
          default: break;
        }
      },

      refreshToday() {
        const t = todayCivil();
        if (t !== get().today) set({ today: t });
      },

      setView(view) { set({ view, selection: [], anchorId: null, focusId: null, editingId: null, filterQuery: '' }); },
      select(ids, anchorId) { set({ selection: ids, anchorId: anchorId === undefined ? (ids[0] ?? null) : anchorId, focusId: ids[ids.length - 1] ?? get().focusId }); },
      setFocus(focusId) { set({ focusId }); },
      setEditing(editingId) { set({ editingId }); },
      setDragging(dragging) {
        set({ dragging });
        if (!dragging) {
          const buffered = get().bufferedEvents;
          set({ bufferedEvents: [] });
          for (const e of buffered) get().applyEvent(e);
        }
      },
      setFilter(filterQuery) { set({ filterQuery }); },
      openOverlay(overlay, overlayPayload = null) { set({ overlay, overlayPayload }); },
      closeOverlay() { set({ overlay: null, overlayPayload: null }); },
      setUi(patch) { set(patch); },
      toggleShowCompleted(listId) { set((s) => ({ showCompletedByList: { ...s.showCompletedByList, [listId]: !s.showCompletedByList[listId] } })); },
      toggleCollapsed(id) {
        set((s) => {
          const next = { ...s.collapsedParents };
          if (next[id]) delete next[id]; else next[id] = true;
          return { collapsedParents: next };
        });
      },

      toast(t) {
        const id = `t${++toastSeq}`;
        set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
        const ms = t.timeoutMs ?? (t.level === 'error' ? 8000 : 5000);
        if (ms > 0) setTimeout(() => get().dismissToast(id), ms);
        return id;
      },
      dismissToast(id) { set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); },
      pushUndo(e) { set((s) => ({ undoPast: [...s.undoPast.slice(-49), e], undoFuture: [] })); },
      async undo() {
        const e = get().undoPast[get().undoPast.length - 1];
        if (!e) return;
        set((s) => ({ undoPast: s.undoPast.slice(0, -1), undoFuture: [...s.undoFuture, e] }));
        await e.undo();
      },
      async redo() {
        const e = get().undoFuture[get().undoFuture.length - 1];
        if (!e) return;
        set((s) => ({ undoFuture: s.undoFuture.slice(0, -1), undoPast: [...s.undoPast, e] }));
        await e.redo();
      },

      async createTask(input) {
        const task = await call('tasks:create', input);
        installTasks([task]);
        return task;
      },
      async updateTask(id, patch) {
        patchLocal(id, patch);
        try {
          const task = await call('tasks:update', { id, patch });
          installTasks([task]);
          return task;
        } catch (e) {
          const fresh = await call('tasks:get', { id }).catch(() => null);
          if (fresh) installTasks([fresh]);
          throw e;
        }
      },
      async setStatus(ids, completed) {
        const now = new Date().toISOString();
        for (const id of ids) patchLocal(id, { status: completed ? 'completed' : 'needsAction', completedAt: completed ? now : null });
        try {
          const tasks = await call('tasks:setStatus', { ids, completed });
          installTasks(tasks);
          return tasks;
        } catch (e) {
          const fresh = await Promise.all(ids.map((id) => call('tasks:get', { id }).catch(() => null)));
          installTasks(fresh.filter((t): t is Task => t !== null));
          throw e;
        }
      },
      async moveTask(input) {
        const task = await call('tasks:move', input);
        installTasks([task]);
        return task;
      },
      async deleteTasks(ids) {
        const subtree = ids.flatMap((id) => [id, ...Object.values(get().tasks).filter((t) => t.parentId === id).map((t) => t.id)]);
        installTasks([], subtree);
        await call('tasks:delete', { ids });
      },
      async restoreTasks(ids) {
        const tasks = await call('tasks:restore', { ids });
        installTasks(tasks);
        return tasks;
      },
    };
  }),
);

// Persist UI slice.
useStore.subscribe(
  (s) => [s.view, s.sidebarWidth, s.sidebarUserCollapsed, s.detailWidth, s.inspectorOpen, s.density, s.showCompletedByList, s.collapsedParents] as const,
  () => saveUi(useStore.getState()),
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);

let unsubscribeEvents: (() => void) | null = null;
/** Connect main-process push events to the store. Idempotent. */
export function connectStoreToMain(): () => void {
  unsubscribeEvents?.();
  unsubscribeEvents = onMainEvent((e) => useStore.getState().applyEvent(e));
  return unsubscribeEvents;
}
