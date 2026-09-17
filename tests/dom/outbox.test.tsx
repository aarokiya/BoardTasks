import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OutboxEntry } from '@shared/models';
import { renderApp } from '../setup/render';
import type { MockApi } from '../setup/mockApi';
import { OutboxSheet } from '../../src/renderer/src/features/outbox/OutboxSheet';

const entry = (p: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: 'o1',
  op: 'task.update',
  entity: 'task',
  entityId: 't1',
  description: 'Rename "Book flights" → "Book flights to Lisbon"',
  status: 'parked',
  attempts: 3,
  nextAttemptAt: new Date().toISOString(),
  lastError: 'HTTP 403 rateLimitExceeded',
  lastErrorCode: 'RATE_LIMITED',
  createdAt: new Date().toISOString(),
  ...p,
});

/** Installs the bridge, stubs outbox:list, then mounts the sheet. */
async function mountSheet(entries: OutboxEntry[]): Promise<MockApi> {
  const { api } = await renderApp(<div data-testid="host" />, { view: 'today' });
  api.stub('outbox:list', () => entries);
  render(<OutboxSheet />);
  return api;
}

describe('OutboxSheet', () => {
  it('shows the empty state when everything is synced', async () => {
    await mountSheet([]);
    expect(await screen.findByText('Everything is synced')).toBeInTheDocument();
  });

  it('lists entries with a human error, the raw detail and how often it was tried', async () => {
    await mountSheet([entry()]);
    expect(await screen.findByText(/Rename "Book flights"/)).toBeInTheDocument();
    expect(screen.getByText(/limiting how fast/i)).toBeInTheDocument();
    // The raw server text is kept, but demoted below the sentence a person reads.
    expect(screen.getByText(/rateLimitExceeded/)).toBeInTheDocument();
    expect(screen.getByText('Tried 3 times')).toBeInTheDocument();
    // No operation codes in user-facing copy.
    expect(screen.queryByText(/task\.update/)).toBeNull();
  });

  it('says nothing about attempts on a first try', async () => {
    await mountSheet([entry({ attempts: 1, status: 'pending', lastError: null, lastErrorCode: null })]);
    await screen.findByText(/Rename "Book flights"/);
    expect(screen.queryByText(/Attempt|Tried/)).toBeNull();
  });

  it('retries a single entry', async () => {
    const user = userEvent.setup();
    const api = await mountSheet([entry()]);
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'outbox:retry')).toBe(true));
  });

  it('retries everything from the footer', async () => {
    const user = userEvent.setup();
    const api = await mountSheet([entry()]);
    await user.click(await screen.findByRole('button', { name: 'Retry all' }));
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'outbox:retryAll')).toBe(true));
  });

  it('asks for confirmation before discarding', async () => {
    const user = userEvent.setup();
    const api = await mountSheet([entry()]);
    await user.click(await screen.findByRole('button', { name: /^Discard change:/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Confirm discard' });
    expect(api.calls.some((c) => c.channel === 'outbox:discard')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'outbox:discard')).toBe(true));
  });

  it('surfaces a failure to load the outbox', async () => {
    const { api } = await renderApp(<div />, { view: 'today' });
    api.stub('outbox:list', () => {
      throw new Error('db locked');
    });
    render(<OutboxSheet />);
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});
