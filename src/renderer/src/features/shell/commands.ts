import type { SmartViewId } from '@shared/constants';
import type { Density } from '@shared/models';
import { registerCommands } from '../../commands/registry';
import { useStore } from '../../store/store';
import { selectCurrentListId, selectTaskRows } from '../../store/selectors/views';
import { announce } from '../../lib/announce';
import { call } from '../../lib/ipc';

const DENSITIES: Density[] = ['compact', 'default', 'comfortable'];

function moveFocus(delta: number): void {
  const st = useStore.getState();
  const rows = selectTaskRows(st);
  if (rows.length === 0) return;
  const idx = rows.findIndex((r) => r.id === st.focusId);
  const next = idx < 0 ? (delta > 0 ? rows[0] : rows[rows.length - 1]) : rows[Math.min(rows.length - 1, Math.max(0, idx + delta))];
  if (!next) return;
  st.setFocus(next.id);
  st.select([next.id], next.id);
  document.getElementById(`bt-row-${next.id}`)?.scrollIntoView({ block: 'nearest' });
}

function goto(view: SmartViewId): void {
  useStore.getState().setView(view);
}

/**
 * Commands owned by the shell track. The Interactions track owns everything
 * else; these are the ones that are purely about shell/list chrome.
 */
export function registerShellCommands(): void {
  registerCommands({
    'view.sidebar': {
      run: ({ store }) => {
        const next = !store.sidebarUserCollapsed;
        store.setUi({ sidebarUserCollapsed: next });
        announce(next ? 'Sidebar hidden' : 'Sidebar shown');
      },
    },
    'view.inspector': {
      run: ({ store }) => {
        const next = !store.inspectorOpen;
        store.setUi({ inspectorOpen: next });
        announce(next ? 'Inspector shown' : 'Inspector hidden');
      },
    },
    'view.density': {
      run: ({ store }) => {
        const next = DENSITIES[(DENSITIES.indexOf(store.density) + 1) % DENSITIES.length] ?? 'default';
        store.setUi({ density: next });
        announce(`Row density: ${next}`);
        // Settings are the source of truth: without this the next hydrate
        // would snap the rows back to the stored density.
        void call('settings:set', { density: next }).catch(() =>
          store.toast({ level: 'error', message: "Couldn't save the row density." }),
        );
      },
    },
    'view.showCompleted': {
      // Toggles the global default (what the View menu's checkbox reflects). A per-list
      // override for the current list is cleared so the new default is what you see.
      run: async ({ store }) => {
        const next = !(store.settings?.showCompletedInLists ?? false);
        const listId = selectCurrentListId(store);
        if (listId && listId in store.showCompletedByList) {
          useStore.setState((st) => {
            const next = { ...st.showCompletedByList };
            delete next[listId];
            return { showCompletedByList: next };
          });
        }
        try {
          const settings = await call('settings:set', { showCompletedInLists: next });
          useStore.setState({ settings });
          announce(next ? 'Showing completed tasks in lists' : 'Hiding completed tasks in lists');
        } catch {
          store.toast({ level: 'error', message: "Couldn't save the completed-tasks preference." });
        }
      },
    },
    'edit.find': {
      run: () => {
        window.dispatchEvent(new CustomEvent('bt:focus-filter'));
      },
    },
    'edit.selectAll': {
      run: ({ store }) => {
        const ids = selectTaskRows(store).map((r) => r.id);
        if (ids.length === 0) return;
        store.select(ids, ids[0] ?? null);
        announce(`${ids.length} task${ids.length === 1 ? '' : 's'} selected`);
      },
    },
    'task.expand': {
      enabled: ({ store }) => store.focusId !== null,
      run: ({ store }) => {
        const id = store.focusId;
        if (!id) return;
        const hasChildren = Object.values(store.tasks).some((t) => t.parentId === id);
        if (!hasChildren) return;
        store.toggleCollapsed(id);
        announce(useStore.getState().collapsedParents[id] ? 'Subtasks collapsed' : 'Subtasks expanded');
      },
    },
    'nav.today': { run: () => goto('today') },
    'nav.upcoming': { run: () => goto('upcoming') },
    'nav.overdue': { run: () => goto('overdue') },
    'nav.all': { run: () => goto('all') },
    'nav.nodate': { run: () => goto('nodate') },
    'nav.github': { run: () => goto('github') },
    'nav.completed': { run: () => goto('completed') },
    'nav.next': { run: () => moveFocus(1) },
    'nav.prev': { run: () => moveFocus(-1) },
  });
}
