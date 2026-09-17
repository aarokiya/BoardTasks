import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GithubStatus } from '@shared/models';
import type { MockApi } from '../../../../../tests/setup/mockApi';
import { renderApp } from '../../../../../tests/setup/render';
import { GithubConnectSettings } from './GithubConnectSettings';

const TOKEN = 'github_pat_11ABCDEFG0123456789';

async function mount(github: Partial<GithubStatus> = {}): Promise<MockApi> {
  const r = await renderApp(<span data-testid="holder" />);
  r.api.state.github = { ...r.api.state.github, ...github };
  r.rerender(<GithubConnectSettings />);
  await screen.findByTestId('gh-settings');
  return r.api;
}

describe('GithubConnectSettings', () => {
  it('explains what kind of token is needed', async () => {
    await mount();
    expect(screen.getByText(/fine-grained personal access token/)).toBeInTheDocument();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByText(/never writes to GitHub/)).toBeInTheDocument();
  });

  it('opens GitHub token creation in the browser', async () => {
    const api = await mount();
    await userEvent.click(screen.getByRole('button', { name: /Create a token on GitHub/ }));
    expect(api.calls.at(-1)).toEqual({ channel: 'app:openExternal', payload: { url: 'https://github.com/settings/personal-access-tokens/new' } });
  });

  it('will not submit an obviously-too-short token', async () => {
    await mount();
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Personal access token'), 'short');
    expect(connect).toBeDisabled();
  });

  it('connects and then shows the account', async () => {
    const api = await mount();
    await userEvent.type(screen.getByLabelText('Personal access token'), TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(api.calls.find((c) => c.channel === 'github:setToken')?.payload).toEqual({ token: TOKEN });
    expect(await screen.findByText('@octocat')).toBeInTheDocument();
    expect(screen.getByText(/Token ending ……1234/)).toBeInTheDocument();
  });

  it('shows why GitHub refused the token', async () => {
    const api = await mount();
    api.failNext('github:setToken', { code: 'UNAUTHENTICATED', message: 'GitHub rejected this token' });
    await userEvent.type(screen.getByLabelText('Personal access token'), TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('GitHub rejected this token')).toBeInTheDocument();
  });

  it('shows the rate limit and scopes when connected', async () => {
    await mount({ connected: true, login: 'octocat', tokenHint: '9f2a', scopes: ['repo'], rateLimitRemaining: 4987, rateLimitResetAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() });
    expect(await screen.findByText('@octocat')).toBeInTheDocument();
    expect(screen.getByText(/4,987 API requests left/)).toBeInTheDocument();
    expect(screen.getByText(/repo/)).toBeInTheDocument();
  });

  it('reports a successful test connection', async () => {
    await mount({ connected: true, login: 'octocat', tokenHint: '9f2a' });
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('GitHub answered as @octocat.')).toBeInTheDocument();
  });

  it('reports a rejected token on test connection', async () => {
    await mount({ connected: true, login: null, tokenHint: '9f2a', error: 'unauthorized' });
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/GitHub rejected the saved token/)).toBeInTheDocument();
  });

  it('disconnects and explains what happens to existing links', async () => {
    const api = await mount({ connected: true, login: 'octocat', tokenHint: '9f2a' });
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(api.calls.some((c) => c.channel === 'github:clearToken')).toBe(true);
    await waitFor(() => { expect(screen.getByText(/Existing links keep their reference/)).toBeInTheDocument(); });
  });
});
