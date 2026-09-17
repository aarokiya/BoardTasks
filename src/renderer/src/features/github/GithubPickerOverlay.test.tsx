import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GithubSearchResult } from '@shared/models';
import type { MockApi } from '../../../../../tests/setup/mockApi';
import { renderApp } from '../../../../../tests/setup/render';
import { useStore } from '../../store/store';
import { GithubPickerOverlay } from './GithubPickerOverlay';

const RESULTS: GithubSearchResult[] = [
  { url: 'https://github.com/o/r/issues/12', owner: 'o', repo: 'r', type: 'issue', number: 12, title: 'Fix the flicker', state: 'open', author: 'ann', updatedAt: new Date().toISOString() },
  { url: 'https://github.com/o/r/pull/13', owner: 'o', repo: 'r', type: 'pull', number: 13, title: 'Speed up sync', state: 'draft', author: 'bob', updatedAt: new Date().toISOString() },
];

async function open(connected = true, results: GithubSearchResult[] = RESULTS): Promise<MockApi> {
  const { api } = await renderApp(<GithubPickerOverlay />);
  api.state.github = { ...api.state.github, connected, login: connected ? 'octocat' : null };
  api.stub('github:search', () => results);
  await act(async () => {
    useStore.getState().openOverlay('github-picker', { taskId: 'task-1' });
    await Promise.resolve();
  });
  await screen.findByTestId('gh-picker');
  return api;
}

const sentQueries = (api: MockApi): string[] =>
  api.calls.filter((c) => c.channel === 'github:search').map((c) => (c.payload as { q: string }).q);

describe('GithubPickerOverlay', () => {
  it('renders nothing unless the overlay is open', async () => {
    const { container } = await renderApp(<GithubPickerOverlay />);
    expect(container.querySelector('[data-testid="gh-picker"]')).toBeNull();
  });

  it('searches for things involving you by default, debounced', async () => {
    const api = await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search GitHub'), 'flicker');
    await waitFor(() => { expect(sentQueries(api).length).toBeGreaterThan(0); });
    // One debounced request, not one per keystroke.
    expect(sentQueries(api)).toHaveLength(1);
    expect(sentQueries(api)[0]).toBe('involves:@me flicker');
    expect(await screen.findByText('Fix the flicker')).toBeInTheDocument();
    expect(screen.getByText('Speed up sync')).toBeInTheDocument();
  });

  it('filter pills change the qualifier that is sent', async () => {
    const api = await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Assigned' }));
    await waitFor(() => { expect(sentQueries(api).some((q) => q.startsWith('assignee:@me'))).toBe(true); });
    await user.click(screen.getByRole('button', { name: 'Created' }));
    await waitFor(() => { expect(sentQueries(api).some((q) => q.startsWith('author:@me'))).toBe(true); });
  });

  it('offers an "all in repo" pill once the query names a repository', async () => {
    const api = await open();
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: /All in/ })).toBeNull();
    await user.type(screen.getByLabelText('Search GitHub'), 'vercel/next.js ');
    const pill = await screen.findByRole('button', { name: 'All in vercel/next.js' });
    await user.click(pill);
    await waitFor(() => { expect(sentQueries(api).some((q) => q.trim() === 'vercel/next.js')).toBe(true); });
  });

  it('links the highlighted result on Enter and closes', async () => {
    const api = await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search GitHub'), 'flicker');
    await screen.findByText('Fix the flicker');
    await user.keyboard('{Enter}');
    await waitFor(() => { expect(api.calls.some((c) => c.channel === 'github:link')).toBe(true); });
    expect(api.calls.find((c) => c.channel === 'github:link')?.payload).toEqual({ taskId: 'task-1', url: 'https://github.com/o/r/issues/12' });
    expect(useStore.getState().overlay).toBeNull();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Linked o/r#12');
  });

  it('arrow keys move the selection', async () => {
    const api = await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search GitHub'), 'flicker');
    await screen.findByText('Speed up sync');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() => { expect(api.calls.some((c) => c.channel === 'github:link')).toBe(true); });
    expect(api.calls.find((c) => c.channel === 'github:link')?.payload).toMatchObject({ url: 'https://github.com/o/r/pull/13' });
  });

  it('a pasted link is recognised without searching', async () => {
    const api = await open();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Search GitHub'));
    await user.paste('https://www.github.com/vercel/next.js/pulls/99?x=1');
    expect(await screen.findByText('Link vercel/next.js#99')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => { expect(api.calls.some((c) => c.channel === 'github:link')).toBe(true); });
    // Canonicalised, and no search was issued for a URL.
    expect(api.calls.find((c) => c.channel === 'github:link')?.payload).toEqual({ taskId: 'task-1', url: 'https://github.com/vercel/next.js/pull/99' });
    expect(sentQueries(api)).toHaveLength(0);
  });

  it('explains the no-token state and routes to settings', async () => {
    await open(false);
    expect(await screen.findByTestId('gh-picker-no-token')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    expect(useStore.getState().overlay).toBe('settings');
  });

  it('shows why a search failed', async () => {
    const api = await open();
    api.stub('github:search', () => { throw new Error('GitHub rate limit reached.'); });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search GitHub'), 'x');
    expect(await screen.findByTestId('gh-picker-error')).toHaveTextContent('GitHub rate limit reached.');
  });

  it('says so when nothing matched', async () => {
    await open(true, []);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search GitHub'), 'zzz');
    expect(await screen.findByText('No matching issues or pull requests.')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    await open();
    await userEvent.keyboard('{Escape}');
    expect(useStore.getState().overlay).toBeNull();
  });
});
