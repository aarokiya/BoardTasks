import { describe, expect, it } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, todayCivil } from '@shared/date/civil';
import { renderApp } from '../setup/render';
import { useStore } from '../../src/renderer/src/store/store';
import { TaskListPane } from '../../src/renderer/src/features/tasklist/TaskListPane';
import { TaskDndProvider } from '../../src/renderer/src/features/dnd/TaskDndProvider';

const today = todayCivil();
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

const ui = (
  <TaskDndProvider>
    <TaskListPane />
  </TaskDndProvider>
);

describe('TaskRow', () => {
  it('names the row with its title and due date', async () => {
    await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Write spec', due: tomorrow }] },
    });
    expect(screen.getByRole('treeitem', { name: 'Write spec, due Tomorrow' })).toBeInTheDocument();
  });

  it('says "Overdue" in the accessible name and marks the date', async () => {
    await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Late', due: yesterday }] },
    });
    expect(screen.getByRole('treeitem', { name: 'Late, due Yesterday, Overdue' })).toBeInTheDocument();
    expect(document.querySelector('[class*="dueOverdue"]')).not.toBeNull();
  });

  it('includes the reminder time, priority, flag and subtask progress in the name', async () => {
    await renderApp(ui, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [
          { id: 't1', listId: 'l1', title: 'Ship it', due: today, dueTime: '14:30', priority: 1, flagged: true },
          { id: 't2', listId: 'l1', title: 'Sub A', parentId: 't1', status: 'completed', completedAt: new Date().toISOString() },
          { id: 't3', listId: 'l1', title: 'Sub B', parentId: 't1' },
        ],
      },
    });
    const row = screen.getByRole('treeitem', { name: /^Ship it/ });
    expect(row.getAttribute('aria-label')).toBe('Ship it, due Today 2:30 PM, High priority, flagged, 1 of 2 subtasks done');
  });

  it('names the row checkbox with its completion state', async () => {
    await renderApp(ui, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [
          { id: 't1', listId: 'l1', title: 'Open one' },
          { id: 't2', listId: 'l1', title: 'Done one', status: 'completed', completedAt: new Date().toISOString() },
        ],
        settings: { showCompletedInLists: true },
      },
    });
    expect(screen.getByRole('checkbox', { name: 'Open one, not completed' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('checkbox', { name: 'Done one, completed' })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the owning list name in smart views only', async () => {
    const { unmount } = await renderApp(ui, {
      view: 'all',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'A' }] },
    });
    expect(screen.getByRole('treeitem', { name: 'A, in Work' })).toBeInTheDocument();
    unmount();

    await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'A' }] },
    });
    expect(screen.getByRole('treeitem', { name: 'A' })).toBeInTheDocument();
  });

  it('edits the title inline with E and commits on Enter', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Old name' }, { id: 't2', listId: 'l1', title: 'Next' }] },
    });
    act(() => useStore.getState().setFocus('t1'));
    await user.keyboard('e');
    const input = await screen.findByRole('textbox', { name: 'Edit title of Old name' });
    await user.clear(input);
    await user.type(input, 'New name{Enter}');
    expect(api.calls.some((c) => c.channel === 'tasks:update' && JSON.stringify(c.payload).includes('New name'))).toBe(true);
    expect(await screen.findByText('New name')).toBeInTheDocument();
    // Enter moves focus to the next row.
    expect(useStore.getState().focusId).toBe('t2');
  });

  it('reverts the title on Escape', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Keep me' }] },
    });
    act(() => useStore.getState().setEditing('t1'));
    const input = await screen.findByRole('textbox', { name: 'Edit title of Keep me' });
    await user.clear(input);
    await user.type(input, 'Throw away{Escape}');
    expect(api.calls.some((c) => c.channel === 'tasks:update')).toBe(false);
    expect(screen.getByText('Keep me')).toBeInTheDocument();
  });

  it('reverts when an existing task is left with an empty title', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Still here' }] },
    });
    act(() => useStore.getState().setEditing('t1'));
    const input = await screen.findByRole('textbox', { name: 'Edit title of Still here' });
    await user.clear(input);
    await user.keyboard('{Enter}');
    expect(api.calls.some((c) => c.channel === 'tasks:update')).toBe(false);
    expect(screen.getByText('Still here')).toBeInTheDocument();
  });

  it('starts an inline edit on double-click', async () => {
    const user = userEvent.setup();
    await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Rename me' }] },
    });
    await user.dblClick(screen.getByText('Rename me'));
    expect(await screen.findByRole('textbox', { name: 'Edit title of Rename me' })).toBeInTheDocument();
  });

  it('surfaces sync and conflict state', async () => {
    await renderApp(ui, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [
          { id: 't1', listId: 'l1', title: 'Pending one', sync: 'pending' },
          { id: 't2', listId: 'l1', title: 'Failed one', sync: 'failed' },
          {
            id: 't3', listId: 'l1', title: 'Conflicted one', sync: 'conflict',
            conflict: { fields: ['title'], server: { title: 'Theirs' }, remoteDeleted: false, detectedAt: new Date().toISOString() },
          },
        ],
      },
    });
    expect(screen.getByRole('treeitem', { name: 'Failed one, failed to sync' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Conflicted one, has a sync conflict' })).toBeInTheDocument();
    expect(document.querySelector('[class*="syncGlyph"]')).not.toBeNull();
  });

  it('shows a notes indicator when the task has notes', async () => {
    await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'With notes', notes: 'details' }] },
    });
    expect(document.querySelector('[class*="noteMark"]')).not.toBeNull();
  });

  it('opens the inspector on Enter', async () => {
    const user = userEvent.setup();
    await renderApp(ui, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'A' }] },
    });
    act(() => {
      useStore.getState().setUi({ inspectorOpen: false });
      useStore.getState().setFocus('t1');
    });
    await user.keyboard('{Enter}');
    expect(useStore.getState().inspectorOpen).toBe(true);
  });
});
