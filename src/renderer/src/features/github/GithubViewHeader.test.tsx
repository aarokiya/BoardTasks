import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask } from '../../../../../tests/setup/mockApi';
import { renderApp } from '../../../../../tests/setup/render';
import { useStore } from '../../store/store';
import { GithubViewHeader } from './GithubViewHeader';
import { makeLink } from './testUtils';

const seedTasks = [
  makeTask({ id: 't1', listId: 'list-1', title: 'issue open', github: makeLink({ taskId: 't1', type: 'issue', state: 'open' }) }),
  makeTask({ id: 't2', listId: 'list-1', title: 'pr failing', github: makeLink({ taskId: 't2', type: 'pull', state: 'open', checks: 'failure' }) }),
  makeTask({ id: 't3', listId: 'list-1', title: 'pr merged', github: makeLink({ taskId: 't3', type: 'pull', state: 'merged' }) }),
  makeTask({ id: 't4', listId: 'list-1', title: 'no link', github: null }),
];

describe('GithubViewHeader', () => {
  it('renders only in the GitHub view', async () => {
    const { container, rerender } = await renderApp(<GithubViewHeader />, { seed: { tasks: seedTasks } });
    expect(container.querySelector('[data-testid="gh-view-header"]')).toBeNull();
    useStore.getState().setView('github');
    rerender(<GithubViewHeader />);
    expect(screen.getByTestId('gh-view-header')).toBeInTheDocument();
  });

  it('counts issues, PRs and failing checks', async () => {
    await renderApp(<GithubViewHeader />, { seed: { tasks: seedTasks }, view: 'github' });
    expect(screen.getByRole('button', { name: 'All 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issues 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PRs 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Failing checks 1' })).toBeInTheDocument();
  });

  it('pills drive the store filter', async () => {
    await renderApp(<GithubViewHeader />, { seed: { tasks: seedTasks }, view: 'github' });
    await userEvent.click(screen.getByRole('button', { name: 'PRs 2' }));
    expect(useStore.getState().githubFilter).toBe('prs');
    expect(screen.getByRole('button', { name: 'PRs 2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('completes every merged or closed item as one undoable action', async () => {
    const { api } = await renderApp(<GithubViewHeader />, { seed: { tasks: seedTasks }, view: 'github' });
    await userEvent.click(screen.getByRole('button', { name: 'Complete tasks for merged/closed items (1)' }));
    expect(api.calls.find((c) => c.channel === 'tasks:setStatus')?.payload).toEqual({ ids: ['t3'], completed: true });
    expect(useStore.getState().undoPast).toHaveLength(1);
    expect(useStore.getState().undoPast[0]!.label).toBe('Complete 1 GitHub task');
  });

  it('hides the bulk action when nothing is merged or closed', async () => {
    await renderApp(<GithubViewHeader />, { seed: { tasks: [seedTasks[0]!] }, view: 'github' });
    expect(screen.queryByRole('button', { name: /Complete tasks for/ })).toBeNull();
  });
});
