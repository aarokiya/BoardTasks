import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../setup/render';
import { useStore } from '../../src/renderer/src/store/store';
import { Onboarding } from '../../src/renderer/src/features/onboarding/Onboarding';
import { ReauthBanner } from '../../src/renderer/src/features/onboarding/ReauthBanner';

const seed = { auth: { state: 'no_credentials' as const, clientIdHint: null }, settings: { onboardingComplete: false } };

/** Walks the wizard from Welcome to the credentials step. */
async function toCredentials(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('Onboarding', () => {
  it('opens on Welcome with a skip-to-offline escape hatch', async () => {
    const { api } = await renderApp(<Onboarding />, { view: 'today', seed });
    const user = userEvent.setup();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 6')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use offline for now' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'settings:set' && (c.payload as { onboardingComplete?: boolean }).onboardingComplete === true)).toBe(true),
    );
  });

  it('validates the Google client id shape before enabling Continue', async () => {
    const user = userEvent.setup();
    await renderApp(<Onboarding />, { view: 'today', seed });
    await toCredentials(user);
    const clientId = screen.getByLabelText('Client ID');
    const secret = screen.getByLabelText('Client secret');
    await user.type(clientId, 'not-a-client-id');
    await user.type(secret, 'GOCSPX-abcdefgh');
    expect(await screen.findByText(/doesn't look like a Desktop OAuth client ID/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await user.clear(clientId);
    await user.type(clientId, '123456789012-abcdefg.apps.googleusercontent.com');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
  });

  it('rejects an obviously wrong client secret', async () => {
    const user = userEvent.setup();
    await renderApp(<Onboarding />, { view: 'today', seed });
    await toCredentials(user);
    await user.type(screen.getByLabelText('Client ID'), '123456789012-abcdefg.apps.googleusercontent.com');
    await user.type(screen.getByLabelText('Client secret'), 'tiny');
    await user.tab();
    expect(await screen.findByText(/Paste the client secret from the same OAuth client/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('shows the waiting state during sign-in and cancels it', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<Onboarding />, { view: 'today', seed });
    await toCredentials(user);
    await user.type(screen.getByLabelText('Client ID'), '123456789012-abcdefg.apps.googleusercontent.com');
    await user.type(screen.getByLabelText('Client secret'), 'GOCSPX-abcdefgh');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    api.stub('auth:signIn', () => new Promise(() => undefined));
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText('Complete sign-in in your browser…')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'auth:cancelSignIn')).toBe(true));
  });

  it('explains a cancelled sign-in and offers a retry', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<Onboarding />, { view: 'today', seed });
    await toCredentials(user);
    await user.type(screen.getByLabelText('Client ID'), '123456789012-abcdefg.apps.googleusercontent.com');
    await user.type(screen.getByLabelText('Client secret'), 'GOCSPX-abcdefgh');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    api.failNext('auth:signIn', { code: 'CANCELLED', message: 'cancelled' });
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((el) => /cancel/i.test(el.textContent ?? ''))).toBe(true));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('opens the Google Cloud setup links externally', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<Onboarding />, { view: 'today', seed });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const openButtons = screen.getAllByRole('button', { name: /^Open/ });
    expect(openButtons.length).toBeGreaterThan(0);
    await user.click(openButtons[0]!);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'app:openExternal')).toBe(true));
  });

  it('starts at the default-list step when already signed in', async () => {
    await renderApp(<Onboarding />, {
      view: 'today',
      seed: { auth: { state: 'signed_in' }, settings: { onboardingComplete: false }, lists: [{ id: 'l1', title: 'Work' }] },
    });
    expect(screen.getByText('Step 5 of 6')).toBeInTheDocument();
  });
});

describe('ReauthBanner', () => {
  it('renders nothing while signed in', async () => {
    await renderApp(<ReauthBanner />, { view: 'today', seed: { auth: { state: 'signed_in' } } });
    expect(screen.queryByRole('button', { name: /sign in again/i })).not.toBeInTheDocument();
  });

  it('explains the Testing-mode refresh-token trap', async () => {
    await renderApp(<ReauthBanner />, {
      view: 'today',
      seed: { auth: { state: 'reauth_required', reason: 'expired_testing_mode' } },
    });
    expect(screen.getByText(/Testing/)).toBeInTheDocument();
    expect(screen.getByText(/unsynced changes are safe/i)).toBeInTheDocument();
  });

  it('explains a keychain decryption failure', async () => {
    await renderApp(<ReauthBanner />, {
      view: 'today',
      seed: { auth: { state: 'reauth_required', reason: 'decrypt_failed' } },
    });
    expect(screen.getByText(/Keychain/i)).toBeInTheDocument();
  });

  it('signs in again from the banner', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<ReauthBanner />, {
      view: 'today',
      seed: { auth: { state: 'reauth_required', reason: 'invalid_grant' } },
    });
    await user.click(screen.getByRole('button', { name: /sign in again/i }));
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'auth:signIn')).toBe(true));
    expect(useStore.getState().auth?.state).toBeDefined();
  });
});
