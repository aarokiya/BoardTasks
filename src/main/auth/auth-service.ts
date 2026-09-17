import { z } from 'zod';
import type { AuthStatus } from '@shared/models';
import { fakeAuthJson } from '../env';
import { createLogger } from '../logger';
import { emit } from '../ipc/emitter';
import { wipeLocalData } from '../db/wipe';
import {
  clearCredentials,
  clearTokens,
  readCredentials,
  seedSessionCredentials,
  updateCredentials,
  writeCredentials,
  type StoredCredentials,
} from './credential-store';
import { startOAuthFlow, type OAuthFlowHandle } from './oauth-flow';
import { revokeToken } from './token-endpoint';
import { TokenManager, classifyGrantDeath, type GrantDeathReason } from './token-manager';
import { AuthError, type TokenProvider } from './types';

const log = createLogger('auth');

const fakeAuthSchema = z.object({
  clientId: z.string().min(1).default('e2e-fake.apps.googleusercontent.com'),
  clientSecret: z.string().min(1).default('e2e-fake-secret'),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive().default(3600),
});

function emptyStatus(state: AuthStatus['state']): AuthStatus {
  return { state, clientIdHint: null, account: null, reason: null, signedInAt: null };
}

/**
 * The single owner of Google credentials and the auth state machine.
 *
 * It is the TokenProvider the API/sync track codes against: call
 * `getAccessToken()` and handle the AuthError, rather than gating on
 * `getStatus().state === 'signed_in'`. The state is a label for the UI —
 * `keychain_unavailable`, for instance, is a fully usable signed-in session
 * that simply will not survive a restart.
 */
export class AuthService implements TokenProvider {
  private status: AuthStatus = emptyStatus('no_credentials');
  private readonly listeners = new Set<(s: AuthStatus) => void>();
  private readonly tokens: TokenManager;
  private flow: OAuthFlowHandle | null = null;
  private signingIn = false;
  private reauthReason: AuthStatus['reason'] = null;
  private fake: { accessToken: string } | null = null;

  constructor() {
    this.tokens = new TokenManager({
      read: () => readCredentials().credentials,
      onRefreshed: (t) => {
        updateCredentials({
          accessToken: t.accessToken,
          accessTokenExpiresAt: t.accessTokenExpiresAt,
          // Google only sends refresh_token back when it rotates one; keep the old one otherwise.
          ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
          ...(t.scope ? { scope: t.scope } : {}),
        });
        this.publish();
      },
      onGrantDead: (reason) => this.onGrantDead(reason),
      fakeAccessToken: () => this.fake?.accessToken ?? null,
    });
  }

  /** Reads persisted credentials (or the E2E seam) and publishes the first status. */
  init(): void {
    if (fakeAuthJson) {
      this.seedFakeAuth(fakeAuthJson);
    } else {
      const snap = readCredentials();
      if (snap.decryptFailed) log.warn('credentials present but undecryptable — surfacing reauth_required');
      if (!snap.persistent && snap.credentials) log.warn('safeStorage unavailable — credentials are session-only');
    }
    this.publish();
  }

  private seedFakeAuth(raw: string): void {
    const parsed = fakeAuthSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      log.error(`BT_FAKE_AUTH is not valid: ${parsed.error.issues[0]?.message ?? 'bad shape'}`);
      return;
    }
    const f = parsed.data;
    this.fake = { accessToken: f.accessToken };
    seedSessionCredentials({
      version: 1,
      clientId: f.clientId,
      clientSecret: f.clientSecret,
      refreshToken: f.refreshToken,
      accessToken: f.accessToken,
      accessTokenExpiresAt: new Date(Date.now() + f.expiresIn * 1000).toISOString(),
      scope: null,
      obtainedAt: new Date().toISOString(),
      accountEmail: null,
    });
    log.info('BT_FAKE_AUTH seeded: signed in for this session, nothing written to disk');
  }

  // ---- TokenProvider ----

  getAccessToken(): Promise<string> {
    return this.tokens.getAccessToken();
  }

  forceRefresh(): Promise<string> {
    return this.tokens.forceRefresh();
  }

  getStatus(): AuthStatus {
    return this.status;
  }

  onStatusChanged(cb: (s: AuthStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  handleInvalidGrant(): void {
    this.tokens.handleInvalidGrant();
  }

  // ---- state machine ----

  private derive(): AuthStatus {
    const snap = readCredentials();
    const c = snap.credentials;
    const hint = c ? c.clientId.slice(-12) : null;

    if (this.signingIn) return { ...emptyStatus('signing_in'), clientIdHint: hint };
    if (snap.decryptFailed) return { ...emptyStatus('reauth_required'), reason: 'decrypt_failed' };
    if (!c) return emptyStatus('no_credentials');
    if (this.reauthReason) return { ...emptyStatus('reauth_required'), clientIdHint: hint, reason: this.reauthReason };

    const signedIn = c.refreshToken !== null;
    // We request only the tasks scope, so Google never tells us who the user is.
    // Adding `openid email` would widen the consent screen for a settings-screen
    // nicety; the account stays anonymous instead. See docs/google-cloud-setup.md.
    const account = signedIn ? { email: c.accountEmail, name: null } : null;
    const signedInAt = signedIn ? c.obtainedAt : null;

    // Credentials exist that we would have persisted but could not: the session
    // works, it just will not survive a restart, and the UI must say so.
    if (!snap.persistent && !this.fake) {
      return { state: 'keychain_unavailable', clientIdHint: hint, account, reason: null, signedInAt };
    }
    return { state: signedIn ? 'signed_in' : 'signed_out', clientIdHint: hint, account, reason: null, signedInAt };
  }

  private publish(): void {
    const next = this.derive();
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    log.info(`auth state → ${next.state}${next.reason ? ` (${next.reason})` : ''}`);
    emit({ type: 'auth:changed', status: next });
    for (const l of this.listeners) l(next);
  }

  private onGrantDead(reason: GrantDeathReason): void {
    // Keep the client id and secret: the user should be one click from signing
    // back in, not back in the Google Cloud console. Never touch the outbox —
    // unsynced changes surviving a re-auth is the whole point of local-first.
    clearTokens();
    this.reauthReason = reason;
    this.publish();
  }

  // ---- commands ----

  setCredentials(input: { clientId: string; clientSecret: string }): AuthStatus {
    const existing = readCredentials().credentials;
    const sameClient = existing?.clientId === input.clientId;
    const base: StoredCredentials = {
      version: 1,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      // Tokens belong to a specific client; a new client id invalidates them.
      refreshToken: sameClient ? (existing?.refreshToken ?? null) : null,
      accessToken: sameClient ? (existing?.accessToken ?? null) : null,
      accessTokenExpiresAt: sameClient ? (existing?.accessTokenExpiresAt ?? null) : null,
      scope: sameClient ? (existing?.scope ?? null) : null,
      obtainedAt: sameClient ? (existing?.obtainedAt ?? null) : null,
      accountEmail: sameClient ? (existing?.accountEmail ?? null) : null,
    };
    writeCredentials(base);
    this.reauthReason = null;
    this.publish();
    return this.status;
  }

  async clearCredentials(): Promise<AuthStatus> {
    this.cancelSignIn();
    await this.revokeBestEffort();
    clearCredentials();
    this.reauthReason = null;
    this.fake = null;
    this.publish();
    return this.status;
  }

  async signIn(): Promise<AuthStatus> {
    if (this.fake) return this.status;

    const snap = readCredentials();
    if (snap.decryptFailed) {
      throw new AuthError('decrypt_failed', 'Your saved Google credentials could not be unlocked. Re-enter your client ID and secret.');
    }
    const c = snap.credentials;
    if (!c) throw new AuthError('no_credentials', 'Add your Google OAuth client ID and secret before signing in.');

    // A second sign-in supersedes the first: two loopback servers and two
    // browser tabs racing to the same credential blob is never what was meant.
    this.flow?.cancel();

    const handle = startOAuthFlow({ clientId: c.clientId, clientSecret: c.clientSecret });
    this.flow = handle;
    this.signingIn = true;
    this.reauthReason = null;
    this.publish();

    try {
      const t = await handle.tokens;
      if (this.flow !== handle) throw new AuthError('cancelled', 'Sign-in was superseded by a newer sign-in.');
      const refreshToken = t.refreshToken ?? c.refreshToken;
      if (!refreshToken) {
        throw new AuthError(
          'not_authenticated',
          'Google did not return a refresh token. Revoke BoardTasks under your Google account permissions and sign in again.',
        );
      }
      const now = Date.now();
      writeCredentials({
        ...c,
        refreshToken,
        accessToken: t.accessToken,
        accessTokenExpiresAt: new Date(now + t.expiresInSec * 1000).toISOString(),
        scope: t.scope,
        obtainedAt: new Date(now).toISOString(),
      });
      log.info('sign-in complete');
    } finally {
      if (this.flow === handle) {
        this.flow = null;
        this.signingIn = false;
      }
      this.publish();
    }
    // Deliberately outside the try: `this.status` is replaced by publish() in
    // the finally, and a `return` inside the try would capture the stale one.
    return this.status;
  }

  cancelSignIn(): AuthStatus {
    if (this.flow) {
      this.flow.cancel();
      this.flow = null;
      this.signingIn = false;
      this.publish();
    }
    return this.status;
  }

  async signOut(opts: { wipeLocalData: boolean }): Promise<AuthStatus> {
    this.cancelSignIn();
    await this.revokeBestEffort();
    clearTokens();
    this.reauthReason = null;
    this.fake = null;
    if (opts.wipeLocalData) wipeLocalData();
    this.publish();
    return this.status;
  }

  /** Telling Google to forget us is courtesy; failing at it must never block a local sign-out. */
  private async revokeBestEffort(): Promise<void> {
    if (this.fake) return;
    const c = readCredentials().credentials;
    const token = c?.refreshToken ?? c?.accessToken ?? null;
    if (!token) return;
    try {
      await revokeToken(token);
    } catch (e) {
      log.warn('token revocation failed (continuing with local sign-out)', e);
    }
  }

  /** Exposed for diagnostics: why a dead grant would be classified the way it is. */
  classifyCurrentGrant(): GrantDeathReason {
    return classifyGrantDeath(readCredentials().credentials?.obtainedAt ?? null, Date.now());
  }
}

let instance: AuthService | null = null;

/** Call once from bootstrap(), after the logger and database are up. */
export function initAuthService(): AuthService {
  instance ??= new AuthService();
  instance.init();
  return instance;
}

export function getAuthService(): AuthService {
  if (!instance) throw new Error('Auth service not initialised — call initAuthService() from bootstrap()');
  return instance;
}

/** Test-only: drop the singleton so the next initAuthService() builds a fresh one. */
export function resetAuthServiceForTests(): void {
  instance = null;
}
