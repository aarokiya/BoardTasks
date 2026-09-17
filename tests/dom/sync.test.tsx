import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SyncState } from '@shared/models';
import { renderApp } from '../setup/render';
import { useStore } from '../../src/renderer/src/store/store';
import { SyncIndicator } from '../../src/renderer/src/features/sync/SyncIndicator';

const pill = (): HTMLElement => screen.getByRole('button', { name: /^Sync status:/ });

const syncState = (p: Partial<SyncState>): Partial<SyncState> => p;

describe('SyncIndicator', () => {
  it('shows the synced state', async () => {
    await renderApp(<SyncIndicator />, { view: 'today', seed: { sync: syncState({ status: 'idle', online: true }) } });
    expect(pill()).toHaveAttribute('data-state', 'idle');
    expect(pill()).toHaveAccessibleName('Sync status: Synced');
  });

  it('does not flash a spinner for a sync shorter than 250ms', async () => {
    vi.useFakeTimers();
    try {
      await renderApp(<SyncIndicator />, { view: 'today', seed: { sync: syncState({ status: 'syncing', online: true }) } });
      expect(pill()).toHaveAccessibleName('Sync status: Synced');
      act(() => { vi.advanceTimersByTime(300); });
      expect(pill()).toHaveAccessibleName('Sync status: Syncing…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows offline with the pending count', async () => {
    await renderApp(<SyncIndicator />, {
      view: 'today',
      seed: { sync: syncState({ status: 'offline', online: false, pendingCount: 3 }) },
    });
    expect(pill()).toHaveAttribute('data-state', 'offline');
    expect(pill()).toHaveAccessibleName('Sync status: Offline, 3 unsynced changes');
  });

  it('shows the error state', async () => {
    await renderApp(<SyncIndicator />, {
      view: 'today',
      seed: { sync: syncState({ status: 'error', errorMessage: 'Google said no' }) },
    });
    expect(pill()).toHaveAttribute('data-state', 'error');
    expect(pill()).toHaveAccessibleName('Sync status: Sync error');
  });

  it('counts down while rate-limited', async () => {
    await renderApp(<SyncIndicator />, {
      view: 'today',
      seed: { sync: syncState({ status: 'rate_limited', retryAfterMs: 42_000 }) },
    });
    expect(pill()).toHaveAttribute('data-state', 'rate_limited');
    expect(pill()).toHaveAccessibleName('Sync status: Retrying in 0:42');
  });

  it('asks for a sign-in when re-auth is required', async () => {
    await renderApp(<SyncIndicator />, {
      view: 'today',
      seed: { auth: { state: 'reauth_required', reason: 'invalid_grant' }, sync: syncState({ status: 'reauth_required' }) },
    });
    expect(pill()).toHaveAttribute('data-state', 'reauth_required');
  });

  it('shows the paused and captive-portal states', async () => {
    const { unmount } = await renderApp(<SyncIndicator />, { view: 'today', seed: { sync: syncState({ status: 'paused' }) } });
    expect(pill()).toHaveAttribute('data-state', 'paused');
    unmount();
    await renderApp(<SyncIndicator />, { view: 'today', seed: { sync: syncState({ status: 'captive_portal' }) } });
    expect(pill()).toHaveAttribute('data-state', 'captive_portal');
  });

  it('opens a popover with Sync now, Full resync and the review link', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<SyncIndicator />, {
      view: 'today',
      seed: { sync: syncState({ status: 'idle', pendingCount: 2 }) },
    });
    await user.click(pill());
    const popover = await screen.findByRole('dialog', { name: 'Sync status' });
    expect(within(popover).getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: 'Full resync' })).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: /Review 2 unsynced changes/ })).toBeInTheDocument();
    await user.click(within(popover).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'sync:now')).toBe(true));
  });

  it('opens the outbox overlay from the review link', async () => {
    const user = userEvent.setup();
    await renderApp(<SyncIndicator />, { view: 'today', seed: { sync: syncState({ status: 'idle', pendingCount: 2 }) } });
    await user.click(pill());
    await user.click(await screen.findByRole('button', { name: /Review 2 unsynced changes/ }));
    expect(useStore.getState().overlay).toBe('outbox');
  });

  it('requests a full resync', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<SyncIndicator />, { view: 'today', seed: { sync: syncState({ status: 'idle' }) } });
    await user.click(pill());
    await user.click(await screen.findByRole('button', { name: 'Full resync' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'sync:now' && (c.payload as { full?: boolean } | undefined)?.full === true)).toBe(true),
    );
  });
});
