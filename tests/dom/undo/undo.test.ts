import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../../src/shared/models';
import { asCivil } from '../../../src/shared/date/civil';
import { REGISTERED_COMMAND_IDS, registerAllCommands } from '../../../src/renderer/src/commands/impl';
import { COMMANDS } from '../../../src/renderer/src/commands/ids';
import { runCommand, isCommandEnabled } from '../../../src/renderer/src/commands/registry';
import { canRedo, canUndo, nextUndoLabel } from '../../../src/renderer/src/features/undo';
import { useStore } from '../../../src/renderer/src/store/store';
import { installMockApi, makeList, makeTask, type MockApi } from '../../setup/mockApi';

/** The mock API hard-deletes; a real backend tombstones, so emulate that here. */
function softDelete(api: MockApi): void {
  const graveyard = new Map<string, Task>();
  api.stub('tasks:delete', (p) => {
    for (const id of p.ids) {
      for (const t of [...api.state.tasks.values()]) {
        if (t.parentId === id) {
          graveyard.set(t.id, t);
          api.state.tasks.delete(t.id);
        }
      }
      const t = api.state.tasks.get(id);
      if (t) {
        graveyard.set(id, t);
        api.state.tasks.delete(id);
      }
    }
  });
  api.stub('tasks:restore', (p) => {
    const out: Task[] = [];
    for (const id of p.ids) {
      const t = graveyard.get(id);
      if (!t) continue;
      const revived = { ...t, rev: t.rev + 1 };
      api.state.tasks.set(id, revived);
      graveyard.delete(id);
      out.push(revived);
    }
    return out;
  });
}

async function setup(): Promise<MockApi> {
  const api = installMockApi({
    lists: [makeList({ id: 'list-1', title: 'Inbox', isDefault: true })],
    tasks: [
      makeTask({ id: 't1', title: 'One', listId: 'list-1', sortKey: 'V1' }),
      makeTask({ id: 't2', title: 'Two', listId: 'list-1', sortKey: 'V2' }),
    ],
  });
  softDelete(api);
  useStore.setState({ tasks: {}, lists: {}, selection: [], focusId: null, overlay: null, toasts: [], undoPast: [], undoFuture: [] });
  await useStore.getState().hydrate();
  registerAllCommands();
  const live = document.createElement('div');
  live.innerHTML = '<div id="bt-status" role="status" aria-live="polite"></div>';
  document.body.appendChild(live);
  return api;
}

beforeEach(() => {
  useStore.setState({ overlay: null, toasts: [], undoPast: [], undoFuture: [] });
});

describe('delete → undo → redo', () => {
  it('deletes the selection and restores it on undo', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.delete');
    expect(useStore.getState().tasks['t1']).toBeUndefined();

    await useStore.getState().undo();
    expect(useStore.getState().tasks['t1']?.title).toBe('One');

    await useStore.getState().redo();
    expect(useStore.getState().tasks['t1']).toBeUndefined();
  });

  it('labels the undo entry with the count', async () => {
    await setup();
    useStore.getState().select(['t1', 't2']);
    await runCommand('task.delete');
    expect(nextUndoLabel()).toBe('Delete 2 tasks');
  });

  it('offers Undo on the toast', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.delete');
    const toast = useStore.getState().toasts.at(-1)!;
    expect(toast.actionLabel).toBe('Undo');
    toast.onAction!();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().tasks['t1']).toBeDefined();
  });

  it('falls back to the focused row when nothing is selected', async () => {
    await setup();
    useStore.setState({ selection: [], focusId: 't2' });
    await runCommand('task.delete');
    expect(useStore.getState().tasks['t2']).toBeUndefined();
  });

  it('is disabled with no target', async () => {
    await setup();
    useStore.setState({ selection: [], focusId: null });
    expect(isCommandEnabled('task.delete')).toBe(false);
    expect(await runCommand('task.delete')).toBe(false);
  });
});

describe('edit.undo / edit.redo', () => {
  it('reports what it undid', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.delete');
    await runCommand('edit.undo');
    expect(useStore.getState().toasts.map((t) => t.message)).toContain('Undid: Delete 1 task');
    expect(useStore.getState().tasks['t1']).toBeDefined();
  });

  it('reports what it redid', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.delete');
    await runCommand('edit.undo');
    await runCommand('edit.redo');
    expect(useStore.getState().toasts.map((t) => t.message)).toContain('Redid: Delete 1 task');
    expect(useStore.getState().tasks['t1']).toBeUndefined();
  });

  it('is disabled when the stacks are empty', async () => {
    await setup();
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
    expect(isCommandEnabled('edit.undo')).toBe(false);
    expect(isCommandEnabled('edit.redo')).toBe(false);
  });

  it('clears the redo stack once a new edit lands', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.delete');
    await runCommand('edit.undo');
    expect(canRedo()).toBe(true);
    useStore.getState().select(['t2']);
    await runCommand('task.due.today');
    expect(canRedo()).toBe(false);
  });
});

describe('undoable field edits', () => {
  it('restores the previous due date', async () => {
    await setup();
    useStore.setState({ today: asCivil('2026-09-17') });
    useStore.getState().select(['t1']);
    await runCommand('task.due.tomorrow');
    expect(useStore.getState().tasks['t1']?.due).toBe('2026-09-18');
    await useStore.getState().undo();
    expect(useStore.getState().tasks['t1']?.due).toBeNull();
    await useStore.getState().redo();
    expect(useStore.getState().tasks['t1']?.due).toBe('2026-09-18');
  });

  it('restores the previous priority', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.priority.1');
    expect(useStore.getState().tasks['t1']?.priority).toBe(1);
    await useStore.getState().undo();
    expect(useStore.getState().tasks['t1']?.priority).toBe(0);
  });

  it('toggles and restores the flag', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.flag');
    expect(useStore.getState().tasks['t1']?.flagged).toBe(true);
    await useStore.getState().undo();
    expect(useStore.getState().tasks['t1']?.flagged).toBe(false);
  });

  it('completes, reopens on a second run, and undoes', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.complete');
    expect(useStore.getState().tasks['t1']?.status).toBe('completed');
    await runCommand('task.complete');
    expect(useStore.getState().tasks['t1']?.status).toBe('needsAction');
    await useStore.getState().undo();
    expect(useStore.getState().tasks['t1']?.status).toBe('completed');
  });

  it('clears the due date and the time together', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.due.today');
    await runCommand('task.due.clear');
    expect(useStore.getState().tasks['t1']?.due).toBeNull();
    await useStore.getState().undo();
    expect(useStore.getState().tasks['t1']?.due).toBe(useStore.getState().today);
  });

  it('restores every task in a multi-selection', async () => {
    await setup();
    useStore.getState().select(['t1', 't2']);
    await runCommand('task.priority.2');
    expect(useStore.getState().tasks['t2']?.priority).toBe(2);
    await useStore.getState().undo();
    expect(useStore.getState().tasks['t1']?.priority).toBe(0);
    expect(useStore.getState().tasks['t2']?.priority).toBe(0);
  });
});

describe('other command bodies', () => {
  it('task.due.pick opens the date picker with the target ids', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.due.pick');
    expect(useStore.getState().overlay).toBe('date-picker');
    expect(useStore.getState().overlayPayload).toEqual({ taskIds: ['t1'] });
  });

  it('task.time.pick opens the time picker', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.time.pick');
    expect(useStore.getState().overlay).toBe('time-picker');
  });

  it('task.move opens the list picker', async () => {
    await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.move');
    expect(useStore.getState().overlay).toBe('list-picker');
  });

  it('task.rename puts the focused row into edit mode', async () => {
    await setup();
    useStore.setState({ focusId: 't1' });
    await runCommand('task.rename');
    expect(useStore.getState().editingId).toBe('t1');
  });

  it('task.duplicate creates a copy and undo removes it', async () => {
    const api = await setup();
    useStore.getState().select(['t1']);
    await runCommand('task.duplicate');
    const copies = [...api.state.tasks.values()].filter((t) => t.title === 'One');
    expect(copies).toHaveLength(2);
    await useStore.getState().undo();
    expect(Object.values(useStore.getState().tasks).filter((t) => t.title === 'One')).toHaveLength(1);
  });

  it('create.task opens the inline row for the current list', async () => {
    await setup();
    useStore.getState().setView('list:list-1');
    await runCommand('create.task');
    expect(useStore.getState().inlineAddFor).toEqual({ listId: 'list-1', parentId: null });
  });

  it('create.subtask targets the focused top-level task', async () => {
    await setup();
    useStore.setState({ focusId: 't1' });
    await runCommand('create.subtask');
    expect(useStore.getState().inlineAddFor).toEqual({ listId: 'list-1', parentId: 't1' });
  });

  it('create.list creates a list, navigates to it and starts a rename', async () => {
    const api = await setup();
    await runCommand('create.list');
    const created = [...api.state.lists.values()].find((l) => l.title === 'New List')!;
    expect(useStore.getState().view).toBe(`list:${created.id}`);
    expect(useStore.getState().renamingListId).toBe(created.id);
  });

  it('view.palette toggles the overlay', async () => {
    await setup();
    await runCommand('view.palette');
    expect(useStore.getState().overlay).toBe('palette');
    await runCommand('view.palette');
    expect(useStore.getState().overlay).toBeNull();
  });

  it('sync.now asks main to sync', async () => {
    const api = await setup();
    await runCommand('sync.now');
    expect(api.calls.some((c) => c.channel === 'sync:now')).toBe(true);
  });

  it('app.revealLogs asks main to reveal the log', async () => {
    const api = await setup();
    await runCommand('app.revealLogs');
    expect(api.calls.some((c) => c.channel === 'app:revealLogs')).toBe(true);
  });

  it('view.theme.dark persists the preference and writes the attribute', async () => {
    const api = await setup();
    await runCommand('view.theme.dark');
    expect(api.state.settings.theme).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('view.zoomIn asks main to zoom', async () => {
    const api = await setup();
    await runCommand('view.zoomIn');
    expect(api.calls.find((c) => c.channel === 'app:setZoom')?.payload).toEqual({ delta: 0.5 });
  });

  it('task.indent is disabled for the first row', async () => {
    await setup();
    useStore.getState().setView('list:list-1');
    useStore.getState().select(['t1']);
    expect(isCommandEnabled('task.indent')).toBe(false);
  });

  it('task.indent nests under the previous sibling', async () => {
    const api = await setup();
    useStore.getState().setView('list:list-1');
    useStore.getState().select(['t2']);
    expect(isCommandEnabled('task.indent')).toBe(true);
    await runCommand('task.indent');
    expect(api.calls.find((c) => c.channel === 'tasks:move')?.payload).toMatchObject({ id: 't2', parentId: 't1' });
  });

  it('task.outdent is disabled at the top level', async () => {
    await setup();
    useStore.getState().select(['t1']);
    expect(isCommandEnabled('task.outdent')).toBe(false);
  });

  it('task.moveDown swaps with the next sibling', async () => {
    const api = await setup();
    useStore.getState().setView('list:list-1');
    useStore.getState().select(['t1']);
    await runCommand('task.moveDown');
    expect(api.calls.find((c) => c.channel === 'tasks:move')?.payload).toMatchObject({ id: 't1', previousId: 't2' });
  });

  it('task.moveUp is disabled for the first row', async () => {
    await setup();
    useStore.getState().setView('list:list-1');
    useStore.getState().select(['t1']);
    expect(isCommandEnabled('task.moveUp')).toBe(false);
  });

  it('task.copyLink is disabled without a web link', async () => {
    await setup();
    useStore.getState().select(['t1']);
    expect(isCommandEnabled('task.copyLink')).toBe(false);
  });
});

describe('command registration', () => {
  /** Owned by the shell track — these must NOT be registered here. */
  const RESERVED = new Set<string>([
    'view.sidebar',
    'view.inspector',
    'view.showCompleted',
    'view.density',
    'edit.find',
    'edit.selectAll',
    'task.expand',
  ]);
  const isReserved = (id: string): boolean => RESERVED.has(id) || id.startsWith('nav.');

  it('registers every command the shell track does not own', () => {
    const expected = COMMANDS.map((c) => c.id).filter((id) => !isReserved(id));
    expect([...REGISTERED_COMMAND_IDS].sort()).toEqual([...expected].sort());
  });

  it('never registers a shell-owned command', () => {
    expect(REGISTERED_COMMAND_IDS.filter(isReserved)).toEqual([]);
  });

  it('is idempotent', async () => {
    await setup();
    registerAllCommands();
    registerAllCommands();
    useStore.getState().select(['t1']);
    expect(isCommandEnabled('task.delete')).toBe(true);
  });
});
