import { z } from 'zod';
import { createLogger, registerSecret } from '../logger';
import { deleteSecret, isPersistent, loadSecret, saveSecret } from './secure-store';

const log = createLogger('auth');

/** One JSON blob, one Keychain entry. Client id + secret are part of it: they are the user's, not ours. */
export const CREDENTIALS_SECRET = 'google-credentials';

export interface StoredCredentials {
  version: 1;
  clientId: string;
  clientSecret: string;
  /** Null when the user has entered credentials but has not signed in yet. */
  refreshToken: string | null;
  accessToken: string | null;
  /** RFC3339 instant. */
  accessTokenExpiresAt: string | null;
  scope: string | null;
  /** When the refresh token was granted — the clock the 7-day Testing-mode trap is measured against. */
  obtainedAt: string | null;
  accountEmail: string | null;
}

const schema = z.object({
  version: z.literal(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().nullable().default(null),
  accessToken: z.string().nullable().default(null),
  accessTokenExpiresAt: z.string().nullable().default(null),
  scope: z.string().nullable().default(null),
  obtainedAt: z.string().nullable().default(null),
  accountEmail: z.string().nullable().default(null),
});

export interface CredentialSnapshot {
  credentials: StoredCredentials | null;
  /** The blob exists but could not be decrypted (e.g. the signing identity changed). */
  decryptFailed: boolean;
  /** False when safeStorage is unavailable: anything written lives only for this session. */
  persistent: boolean;
}

let cache: StoredCredentials | null = null;
let loaded = false;
let decryptFailed = false;
/** E2E: credentials seeded from BT_FAKE_AUTH must never touch disk. */
let sessionOnly = false;

function remember(c: StoredCredentials): void {
  registerSecret(c.clientSecret);
  registerSecret(c.refreshToken);
  registerSecret(c.accessToken);
}

export function readCredentials(): CredentialSnapshot {
  if (!loaded) {
    loaded = true;
    try {
      const raw = loadSecret(CREDENTIALS_SECRET);
      if (raw) {
        const parsed = schema.safeParse(JSON.parse(raw) as unknown);
        if (parsed.success) {
          cache = parsed.data;
          remember(cache);
        } else {
          // A blob we cannot understand is as good as no blob, but destroying it
          // silently would lose a recoverable refresh token, so it stays on disk.
          log.error('stored credentials failed validation; treating as absent', parsed.error.issues[0]?.message ?? '');
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'decrypt_failed') {
        decryptFailed = true;
        log.error('stored credentials could not be decrypted; re-authentication required');
      } else {
        log.error('stored credentials could not be read', e);
      }
    }
  }
  return { credentials: cache, decryptFailed, persistent: isPersistent() };
}

export function writeCredentials(c: StoredCredentials): StoredCredentials {
  loaded = true;
  decryptFailed = false;
  cache = c;
  remember(c);
  if (sessionOnly) return c;
  saveSecret(CREDENTIALS_SECRET, JSON.stringify(c));
  return c;
}

/** Patch the stored blob. No-op (returns null) when there is nothing stored. */
export function updateCredentials(patch: Partial<Omit<StoredCredentials, 'version'>>): StoredCredentials | null {
  const current = readCredentials().credentials;
  if (!current) return null;
  return writeCredentials({ ...current, ...patch });
}

/**
 * Drop the tokens, keep the client id and secret. This is what `invalid_grant`
 * and sign-out do: the user should be one "Sign in" click away, not back in
 * the Google Cloud console re-copying a client id.
 */
export function clearTokens(): StoredCredentials | null {
  return updateCredentials({ refreshToken: null, accessToken: null, accessTokenExpiresAt: null, scope: null, obtainedAt: null, accountEmail: null });
}

export function clearCredentials(): void {
  cache = null;
  loaded = true;
  decryptFailed = false;
  deleteSecret(CREDENTIALS_SECRET);
}

/** E2E seam: hold these credentials in memory for this session and never persist them. */
export function seedSessionCredentials(c: StoredCredentials): void {
  sessionOnly = true;
  loaded = true;
  decryptFailed = false;
  cache = c;
  remember(c);
}

export function isSessionOnly(): boolean {
  return sessionOnly;
}

/** Test-only: forget what this module cached so the next read hits secure-store again. */
export function resetCredentialCacheForTests(): void {
  cache = null;
  loaded = false;
  decryptFailed = false;
  sessionOnly = false;
}
