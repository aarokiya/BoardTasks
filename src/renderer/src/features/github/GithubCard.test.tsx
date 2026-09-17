import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GithubLink, Task } from '@shared/models';
import { makeTask } from '../../../../../tests/setup/mockApi';
import { renderApp } from '../../../../../tests/setup/render';
import { useStore } from '../../store/store';
import { GithubCard } from './GithubCard';
import { makeLink } from './testUtils';

async function mount(link: Partial<GithubLink>, task: Partial<Task> = {}) {
  const github = makeLink({ taskId: 'task-1', ...link });
  const t = makeTask({ id: 'task-1', listId: 'list-1', title: 'Ship it', github, ...task });
  const r = await renderApp(<GithubCard task={t} />, { seed: { tasks: [t] } });
  return { ...r, task: t };
}

describe('GithubCard', () => {
  it('shows the item, its author and its labels', async () => {
    await mount({ title: 'Fix the flicker', author: 'octocat', labels: [{ name: 'bug', color: 'd73a4a' }] });
    expect(screen.getByRole('heading', { name: 'Fix the flicker' })).toBeInTheDocument();
    expect(screen.getByTestId('gh-card')).toHaveTextContent('o/r #12');
    expect(screen.getByTestId('gh-card')).toHaveTextContent('@octocat');
    expect(screen.getByText('bug')).toBeInTheDocument();
  });

  it('shows checks and review state for a pull request only', async () => {
    const { unmount } = await mount({ type: 'pull', checks: 'failure', reviewDecision: 'changes_requested' });
    expect(screen.getByText('Checks failing')).toBeInTheDocument();
    expect(screen.getByText('Changes requested')).toBeInTheDocument();
    unmount();
    await mount({ type: 'issue', checks: 'failure', reviewDecision: 'approved' });
    expect(screen.queryByText('Checks failing')).not.toBeInTheDocument();
  });

  it('refreshes through main', async () => {
    const { api } = await mount({});
    await userEvent.click(screen.getByRole('button', { name: 'Refresh from GitHub' }));
    expect(api.calls.some((c) => c.channel === 'github:refresh')).toBe(true);
    expect(api.calls.find((c) => c.channel === 'github:refresh')?.payload).toEqual({ taskId: 'task-1' });
  });

  it('opens the item externally', async () => {
    const { api } = await mount({ url: 'https://github.com/o/r/issues/12' });
    await userEvent.click(screen.getByRole('button', { name: 'Open ↗' }));
    expect(api.calls.at(-1)).toEqual({ channel: 'app:openExternal', payload: { url: 'https://github.com/o/r/issues/12' } });
  });

  it('unlinks and drops the link from the store immediately', async () => {
    const { api } = await mount({});
    await userEvent.click(screen.getByRole('button', { name: 'Remove GitHub link' }));
    expect(api.calls.some((c) => c.channel === 'github:unlink')).toBe(true);
    expect(useStore.getState().tasks['task-1']?.github).toBeNull();
  });

  it('offers to complete the task when the PR is merged', async () => {
    const { api } = await mount({ state: 'merged', type: 'pull' }, { status: 'needsAction' });
    expect(screen.getByText('Merged — complete this task?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }));
    const call = api.calls.find((c) => c.channel === 'tasks:setStatus');
    expect(call?.payload).toEqual({ ids: ['task-1'], completed: true });
  });

  it('does not nag when the task is already complete', async () => {
    await mount({ state: 'closed' }, { status: 'completed' });
    expect(screen.queryByText(/complete this task/)).not.toBeInTheDocument();
  });

  it('explains a missing token and routes to settings', async () => {
    await mount({ error: 'no_token', state: null, title: null });
    expect(screen.getByText(/Connect GitHub to see status/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect GitHub…' }));
    expect(useStore.getState().overlay).toBe('settings');
  });

  it('offers a new token when GitHub rejects the saved one', async () => {
    await mount({ error: 'unauthorized' });
    expect(screen.getByText(/GitHub rejected the saved token/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update token…' })).toBeInTheDocument();
  });

  it('explains a repository the token cannot see', async () => {
    await mount({ error: 'forbidden' });
    expect(screen.getByText(/cannot see that repository/)).toBeInTheDocument();
  });

  it('offers to remove a link whose item is gone', async () => {
    const { api } = await mount({ error: 'not_found' });
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(api.calls.some((c) => c.channel === 'github:unlink')).toBe(true);
  });

  it('offers a retry when GitHub could not be reached', async () => {
    const { api } = await mount({ error: 'network' });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(api.calls.some((c) => c.channel === 'github:refresh')).toBe(true);
  });

  it('surfaces a failed refresh as a toast instead of a dead button', async () => {
    const { api } = await mount({});
    api.failNext('github:refresh');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh from GitHub' }));
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Could not refresh from GitHub.');
  });

  it('renders nothing for a task with no link', async () => {
    const t = makeTask({ id: 'task-2', github: null });
    const { container } = await renderApp(<GithubCard task={t} />, { seed: { tasks: [t] } });
    expect(container.querySelector('[data-testid="gh-card"]')).toBeNull();
  });
});
