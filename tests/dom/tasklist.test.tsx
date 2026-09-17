import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayCivil } from '@shared/date/civil';
import { renderApp } from '../setup/render';
import { makeTask } from '../setup/mockApi';
import { useStore } from '../../src/renderer/src/store/store';
import { TaskListPane } from '../../src/renderer/src/features/tasklist/TaskListPane';
import { TaskDndProvider } from '../../src/renderer/src/features/dnd/TaskDndProvider';
import { registerShellCommands } from '../../src/renderer/src/features/shell/commands';
import { runCommand } from '../../src/renderer/src/commands/registry';

registerShellCommands();

const today = todayCivil();
const yesterday = addDays(today, -1);

const ui = (
  <TaskDndProvider>
    <TaskListPane />
  </TaskDndProvider>
);

const rows = (): HTMLElement[] => screen.queryAllByTestId('task-row');

describe('TaskList', () => {
  it('groups the Today view as Overdue then Today', async () => {
    await renderApp(ui, {
      view: 'today',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [
          { id: 't1', listId: 'l1', title: 'Late thing', due: yesterday },
          { id: 't2', listId: 'l1', title: 'Today thing', due: today },
        ],
      },
    });
    const headers = screen.getAllByRole('button', { name: /, \d+ task/ }).map((b) => b.textContent ?? '');
    expect(headers[0]).toMatch(/Overdue/);
    expect(headers[1]).toMatch(/Today/);
    expect(rows().map((r) => r.getAttribute('data-task-id'))).toEqual(['t1', 't2']);
  });

  it('keeps exactly one row in the tab order', async () => {
    await renderApp(ui, {
      view: 'all',
      seed: { lists: [{ id: 'l1' }], tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }, { id: 't3', title: 'C' }] },
    });
    act(() => useStore.getState().setFocus('t2'));
    await waitFor(() => expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1));
    expect(rows().find((r) => r.tabIndex === 0)?.getAttribute('data-task-id')).toBe('t2');
  });

  it('moves focus with j and k', async () => {
    const user = userEvent.setup();
    await renderApp(ui, {
      view: 'all',
      seed: { lists: [{ id: 'l1' }], tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }, { id: 't3', title: 'C' }] },
    });
    act(() => useStore.getState().setFocus('t1'));
    await waitFor(() => expect(document.activeElement?.getAttribute('data-task-id')).toBe('t1'));
    await user.keyboard('j');
    expect(useStore.getState().focusId).toBe('t2');
    await user.keyboard('j');
    expect(useStore.getState().focusId).toBe('t3');
    await user.keyboard('k');
    expect(useStore.getState().focusId).toBe('t2');
  });

  it('completes with Space optimistically, before the IPC call resolves', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'A' }], settings: { showCompletedInLists: true } },
    });
    let resolveCall: (() => void) | null = null;
    api.stub('tasks:setStatus', () => new Promise((resolve) => { resolveCall = () => resolve([]); }));

    act(() => useStore.getState().setFocus('t1'));
    await waitFor(() => expect(document.activeElement?.getAttribute('data-task-id')).toBe('t1'));
    await user.keyboard(' ');

    expect(screen.getByRole('checkbox', { name: 'A, completed' })).toBeInTheDocument();
    expect(useStore.getState().tasks['t1']?.status).toBe('completed');
    expect(resolveCall).not.toBeNull();
    act(() => resolveCall?.());
  });

  it('collapses a row out of the view when completing it removes it', async () => {
    const user = userEvent.setup();
    await renderApp(ui, { view: 'all', seed: { lists: [{ id: 'l1' }], tasks: [{ id: 't1', title: 'A' }] } });
    await user.click(screen.getByRole('checkbox', { name: 'A, not completed' }));
    expect(screen.queryByTestId('task-row')).not.toBeInTheDocument();
    // The ghost keeps the row visible for the 220ms collapse.
    expect(document.querySelector('[class*="ghost"]')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('[class*="ghost"]')).toBeNull(), { timeout: 1000 });
  });

  it('extends the selection with shift-click in visual order', async () => {
    const user = userEvent.setup();
    await renderApp(ui, {
      view: 'all',
      seed: {
        lists: [{ id: 'l1' }],
        tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }, { id: 't3', title: 'C' }, { id: 't4', title: 'D' }],
      },
    });
    await user.click(screen.getByText('A'));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByText('C'));
    await user.keyboard('{/Shift}');
    expect(useStore.getState().selection).toEqual(['t1', 't2', 't3']);
  });

  it('toggles individual rows with cmd-click', async () => {
    const user = userEvent.setup();
    await renderApp(ui, {
      view: 'all',
      seed: { lists: [{ id: 'l1' }], tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }, { id: 't3', title: 'C' }] },
    });
    await user.click(screen.getByText('A'));
    await user.keyboard('{Meta>}');
    await user.click(screen.getByText('C'));
    await user.keyboard('{/Meta}');
    expect(useStore.getState().selection).toEqual(['t1', 't3']);
    await user.keyboard('{Meta>}');
    await user.click(screen.getByText('C'));
    await user.keyboard('{/Meta}');
    expect(useStore.getState().selection).toEqual(['t1']);
  });

  it('extends the selection with shift and the arrow keys', async () => {
    const user = userEvent.setup();
    await renderApp(ui, {
      view: 'all',
      seed: { lists: [{ id: 'l1' }], tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }, { id: 't3', title: 'C' }] },
    });
    await user.click(screen.getByText('A'));
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(useStore.getState().selection).toEqual(['t1', 't2', 't3']);
  });

  it('selects every task row with edit.selectAll', async () => {
    await renderApp(ui, {
      view: 'all',
      seed: { lists: [{ id: 'l1' }], tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }] },
    });
    await act(async () => { await runCommand('edit.selectAll'); });
    expect(useStore.getState().selection).toEqual(['t1', 't2']);
    expect(await screen.findByRole('toolbar', { name: '2 tasks selected' })).toBeInTheDocument();
  });

  it('shows the Today empty state with a link to Upcoming', async () => {
    const user = userEvent.setup();
    await renderApp(ui, { view: 'today', seed: { lists: [{ id: 'l1' }] } });
    expect(screen.getByText('Nothing due today')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Upcoming' }));
    expect(useStore.getState().view).toBe('upcoming');
  });

  it('shows the list empty state', async () => {
    await renderApp(ui, { view: 'list:l1', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.getByText('Press ⌘N to add the first one.')).toBeInTheDocument();
  });

  it('shows the completed empty state', async () => {
    await renderApp(ui, { view: 'completed', seed: { lists: [{ id: 'l1' }] } });
    expect(screen.getByText('Completed tasks will appear here.')).toBeInTheDocument();
  });

  it('shows a no-match state when the filter excludes everything', async () => {
    const user = userEvent.setup();
    await renderApp(ui, { view: 'all', seed: { lists: [{ id: 'l1' }], tasks: [{ id: 't1', title: 'Alpha' }] } });
    act(() => useStore.getState().setFilter('zzz'));
    expect(await screen.findByText('No matches')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(useStore.getState().filterQuery).toBe('');
  });

  it('delays skeleton rows by 150ms', async () => {
    vi.useFakeTimers();
    try {
      await renderApp(ui, { view: 'all', seed: { lists: [{ id: 'l1' }] } });
      act(() => useStore.setState({ hydrated: false }));
      expect(document.querySelectorAll('[class*="skeletonRow"]')).toHaveLength(0);
      act(() => { vi.advanceTimersByTime(200); });
      expect(document.querySelectorAll('[class*="skeletonRow"]').length).toBeGreaterThan(0);
    } finally {
      act(() => useStore.setState({ hydrated: true }));
      vi.useRealTimers();
    }
  });

  it('buffers pushes that arrive mid-drag and applies them on drop', async () => {
    const { api } = await renderApp(ui, { view: 'all', seed: { lists: [{ id: 'l1' }], tasks: [{ id: 't1', title: 'A' }] } });
    act(() => useStore.getState().setDragging(true));
    const incoming = makeTask({ id: 'tx', listId: 'l1', title: 'Arrived mid-drag' });
    act(() => api.emit({ type: 'data:changed', reason: 'sync', tasks: [incoming], lists: [], deletedTaskIds: [], deletedListIds: [] }));
    expect(screen.queryByText('Arrived mid-drag')).not.toBeInTheDocument();
    act(() => useStore.getState().setDragging(false));
    expect(await screen.findByText('Arrived mid-drag')).toBeInTheDocument();
  });

  it('indents subtasks one level with a guide line', async () => {
    await renderApp(ui, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [{ id: 't1', listId: 'l1', title: 'Parent' }, { id: 't2', listId: 'l1', title: 'Child', parentId: 't1' }],
      },
    });
    const child = rows().find((r) => r.getAttribute('data-task-id') === 't2');
    expect(child).toHaveAttribute('aria-level', '2');
    expect(child).toHaveAttribute('data-depth', '1');
    const parent = rows().find((r) => r.getAttribute('data-task-id') === 't1');
    expect(parent).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses and expands subtasks from the row disclosure', async () => {
    const user = userEvent.setup();
    await renderApp(ui, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [{ id: 't1', listId: 'l1', title: 'Parent' }, { id: 't2', listId: 'l1', title: 'Child', parentId: 't1' }],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Collapse subtasks of Parent' }));
    expect(screen.queryByText('Child')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand subtasks of Parent' }));
    expect(screen.getByText('Child')).toBeInTheDocument();
  });
});

describe('TaskList virtualization', () => {
  it('renders every row below the 200-row threshold', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, listId: 'l1', title: `Task ${i}` }));
    await renderApp(ui, { view: 'list:l1', seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: many } });
    expect(rows()).toHaveLength(40);
  });

  it('windows the rows above the 200-row threshold', async () => {
    const many = Array.from({ length: 260 }, (_, i) => ({ id: `t${i}`, listId: 'l1', title: `Task ${i}` }));
    await renderApp(ui, { view: 'list:l1', seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: many } });
    // jsdom reports a zero-height scroller, so the window is empty here; what
    // matters is that the virtualizer took over instead of mounting 260 rows.
    expect(document.querySelector('[class*="virtualInner"]')).not.toBeNull();
    expect(rows().length).toBeLessThan(260);
  });
});
