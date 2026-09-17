import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../setup/render';
import { useStore } from '../../src/renderer/src/store/store';
import { SettingsPanel } from '../../src/renderer/src/features/settings/SettingsPanel';

describe('SettingsPanel', () => {
  it('opens on General with a vertical tablist', async () => {
    await renderApp(<SettingsPanel />, { view: 'today' });
    const tablist = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
    expect(within(tablist).getByRole('tab', { name: /General/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('changes the theme through settings:set', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<SettingsPanel />, { view: 'today' });
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'settings:set' && (c.payload as { theme?: string }).theme === 'dark')).toBe(true),
    );
  });

  it('changes row density and mirrors it into the store', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<SettingsPanel />, { view: 'today' });
    await user.click(screen.getByRole('radio', { name: 'Comfortable' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'settings:set' && (c.payload as { density?: string }).density === 'comfortable')).toBe(true),
    );
    expect(useStore.getState().density).toBe('comfortable');
  });

  it('sends a test notification', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<SettingsPanel />, { view: 'today' });
    await user.click(screen.getByRole('tab', { name: /Notifications/ }));
    await user.click(await screen.findByRole('button', { name: 'Send test notification' }));
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'notifications:test')).toBe(true));
  });

  it('warns about unsynced changes before signing out', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<SettingsPanel />, { view: 'today', seed: { sync: { pendingCount: 4 } } });
    await user.click(screen.getByRole('tab', { name: /Sync/ }));
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    const confirm = await screen.findByRole('dialog', { name: 'Sign out of Google?' });
    expect(within(confirm).getByText(/4 unsynced/i)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('checkbox', { name: /delete tasks stored on this computer/i }));
    await user.click(within(confirm).getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'auth:signOut' && (c.payload as { wipeLocalData: boolean }).wipeLocalData === true)).toBe(true),
    );
  });

  it('opens the shortcuts overlay from the Shortcuts section', async () => {
    const user = userEvent.setup();
    await renderApp(<SettingsPanel />, { view: 'today' });
    await user.click(screen.getByRole('tab', { name: /Shortcuts/ }));
    await user.click(await screen.findByRole('button', { name: /keyboard shortcuts/i }));
    expect(useStore.getState().overlay).toBe('shortcuts');
  });

  it('shows the app version and log path in About', async () => {
    const user = userEvent.setup();
    await renderApp(<SettingsPanel />, { view: 'today' });
    await user.click(screen.getByRole('tab', { name: /About/ }));
    expect(await screen.findByText(/0\.0\.0-test/)).toBeInTheDocument();
    expect(screen.getByText('/tmp/main.log')).toBeInTheDocument();
  });
});
