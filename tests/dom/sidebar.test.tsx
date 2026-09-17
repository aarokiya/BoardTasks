import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayCivil } from '@shared/date/civil';
import { renderApp } from '../setup/render';
import { useStore } from '../../src/renderer/src/store/store';
import { Sidebar } from '../../src/renderer/src/features/sidebar/Sidebar';
import { TaskDndProvider } from '../../src/renderer/src/features/dnd/TaskDndProvider';

const today = todayCivil();
const yesterday = addDays(today, -1);
const inThreeDays = addDays(today, 3);

const ui = (
  <TaskDndProvider>
    <Sidebar rail={false} onNavigate={() => {}} />
  </TaskDndProvider>
);

describe('Sidebar', () => {
  it('shows a count on each smart view', async () => {
    await renderApp(ui, {
      view: 'today',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [
          { id: 't1', listId: 'l1', title: 'Due today', due: today },
          { id: 't2', listId: 'l1', title: 'Soon', due: inThreeDays },
          { id: 't3', listId: 'l1', title: 'Someday' },
        ],
      },
    });
    expect(screen.getByRole('treeitem', { name: /^Today, 1 task/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /^Upcoming, 1 task/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /^All, 3 tasks/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /^No Date, 1 task/ })).toBeInTheDocument();
  });

  it('marks the Today badge urgent when overdue tasks roll in', async () => {
    await renderApp(ui, {
      view: 'today',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Late', due: yesterday }] },
    });
    expect(screen.getByRole('treeitem', { name: /Today, 1 task, includes overdue/ })).toBeInTheDocument();
  });

  it('hides Overdue when nothing is overdue and shows it when something is', async () => {
    const { unmount } = await renderApp(ui, {
      view: 'today',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Fine', due: today }] },
    });
    expect(screen.queryByRole('treeitem', { name: /^Overdue/ })).not.toBeInTheDocument();
    unmount();

    await renderApp(ui, {
      view: 'today',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't2', listId: 'l1', title: 'Late', due: yesterday }] },
    });
    expect(screen.getByRole('treeitem', { name: /^Overdue, 1 task/ })).toBeInTheDocument();
  });

  it('shows list rows with their incomplete count and hides the count at zero', async () => {
    await renderApp(ui, {
      view: 'today',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }, { id: 'l2', title: 'Empty', position: 1 }],
        tasks: [
          { id: 't1', listId: 'l1', title: 'A' },
          { id: 't2', listId: 'l1', title: 'B', parentId: 't1' },
        ],
      },
    });
    expect(screen.getByRole('treeitem', { name: 'Work, 2 tasks' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Empty' })).toBeInTheDocument();
  });

  it('navigates to a list when its row is clicked', async () => {
    const user = userEvent.setup();
    await renderApp(ui, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    await user.click(screen.getByRole('treeitem', { name: 'Work' }));
    expect(useStore.getState().view).toBe('list:l1');
  });

  it('renames a list inline on double-click and commits on Enter', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(ui, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    await user.dblClick(screen.getByRole('treeitem', { name: 'Work' }));
    const input = screen.getByRole('textbox', { name: 'Rename Work' });
    await user.clear(input);
    await user.type(input, 'Projects{Enter}');
    expect(api.calls.some((c) => c.channel === 'lists:update' && (c.payload as { title?: string }).title === 'Projects')).toBe(true);
    expect(await screen.findByRole('treeitem', { name: 'Projects' })).toBeInTheDocument();
  });

  it('reverts an inline rename on Escape', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(ui, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    await user.dblClick(screen.getByRole('treeitem', { name: 'Work' }));
    const input = screen.getByRole('textbox', { name: 'Rename Work' });
    await user.clear(input);
    await user.type(input, 'Nope{Escape}');
    expect(api.calls.some((c) => c.channel === 'lists:update')).toBe(false);
    expect(screen.getByRole('treeitem', { name: 'Work' })).toBeInTheDocument();
  });

  it('moves roving focus with the arrow keys', async () => {
    const user = userEvent.setup();
    await renderApp(ui, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    const todayRow = screen.getByRole('treeitem', { name: /^Today/ });
    todayRow.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /^Upcoming/ }));
  });

  it('creates a list from the footer input', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(ui, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    await user.click(screen.getByRole('button', { name: 'New list' }));
    await user.type(screen.getByRole('textbox', { name: 'New list name' }), 'Shopping{Enter}');
    expect(api.calls.some((c) => c.channel === 'lists:create')).toBe(true);
    expect(await screen.findByRole('treeitem', { name: 'Shopping' })).toBeInTheDocument();
  });

  it('confirms before deleting a list', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(ui, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    const row = screen.getByRole('treeitem', { name: 'Work' });
    await user.pointer({ target: row, keys: '[MouseRight]' });
    await user.click(await screen.findByRole('menuitem', { name: 'Delete list…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/can't be undone/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^Delete list$/ }));
    expect(api.calls.some((c) => c.channel === 'lists:delete')).toBe(true);
  });

  it('explains browsable cached data while signed out', async () => {
    await renderApp(ui, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }], auth: { state: 'signed_out' } } });
    expect(screen.getByText(/signed out/i)).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Work' })).toBeInTheDocument();
  });
});
