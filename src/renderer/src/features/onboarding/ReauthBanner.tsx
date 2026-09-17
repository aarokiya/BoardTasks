import { useState, type ReactElement } from 'react';
import type { AuthStatus } from '@shared/models';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { IconAlert, IconExternal, IconX } from '../../components/icons';
import s from './Onboarding.module.css';

const CONSENT_SCREEN_URL = 'https://console.cloud.google.com/auth/audience';

interface Copy {
  text: string;
  showCloudLink: boolean;
}

function copyFor(reason: AuthStatus['reason']): Copy {
  switch (reason) {
    case 'expired_testing_mode':
      return {
        text:
          'Google expired your sign-in because your OAuth consent screen is still in Testing. Set it to In production in Google Cloud and this stops happening.',
        showCloudLink: true,
      };
    case 'decrypt_failed':
      return {
        text:
          "BoardTasks couldn't read your saved credentials from the macOS Keychain. Signing in again will store a fresh copy.",
        showCloudLink: false,
      };
    case 'revoked':
      return { text: 'Access was revoked for this Google account.', showCloudLink: false };
    default:
      return { text: 'Your Google sign-in expired.', showCloudLink: false };
  }
}

export function ReauthBanner(): ReactElement | null {
  const auth = useStore((st) => st.auth);
  const toast = useStore((st) => st.toast);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (auth?.state !== 'reauth_required' || dismissed) return null;

  const { text, showCloudLink } = copyFor(auth.reason);

  const signIn = (): void => {
    setBusy(true);
    void call('auth:signIn')
      .catch((e: unknown) => toast({ level: 'error', message: `Sign-in failed${e instanceof Error ? `: ${e.message}` : ''}` }))
      .finally(() => setBusy(false));
  };

  return (
    <div className={s.banner} role="status">
      <span className={s.bannerIcon} aria-hidden="true">
        <IconAlert size={15} />
      </span>
      <div className={s.bannerBody}>
        <span className={s.bannerText}>{text}</span>
        <span className={s.bannerNote}>Your unsynced changes are safe and will sync once you&rsquo;re signed back in.</span>
        <div className={s.bannerActions}>
          <Button size="sm" variant="primary" disabled={busy} onClick={signIn}>
            Sign in again
          </Button>
          {showCloudLink ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<IconExternal size={13} />}
              onClick={() =>
                void call('app:openExternal', { url: CONSENT_SCREEN_URL }).catch((e: unknown) =>
                  toast({ level: 'error', message: `Could not open Google Cloud${e instanceof Error ? `: ${e.message}` : ''}` }),
                )
              }
            >
              Open Google Cloud
            </Button>
          ) : null}
        </div>
      </div>
      <IconButton size="sm" label="Dismiss re-authentication notice" icon={<IconX size={13} />} onClick={() => setDismissed(true)} />
    </div>
  );
}
