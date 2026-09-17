import { createLogger } from '../logger';
import type { StoredCredentials } from './credential-store';
import { GoogleOAuthError, describeOAuthError, refreshAccessToken, type TokenResponse } from './token-endpoint';
import { AuthError } from './types';

const log = createLogger('auth');

/** Refresh this far ahead of expiry so a request never races the boundary. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Google issues refresh tokens that die after 7 days while an External consent
 * screen is still in "Testing". If invalid_grant lands in that window the cause
 * is almost certainly the publishing status, not a revoked grant — and telling
 * the user to "sign in again" every week without explaining why looks like our bug.
 */
export const TESTING_MODE_MIN_MS = 6 * 24 * 60 * 60 * 1000;
export const TESTING_MODE_MAX_MS = 8 * 24 * 60 * 60 * 1000;

export type GrantDeathReason = 'invalid_grant' | 'expired_testing_mode';

export interface RefreshedTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  /** Non-null only when Google rotated it. */
  refreshToken: string | null;
  scope: string | null;
}

export interface TokenManagerDeps {
  read(): StoredCredentials | null;
  onRefreshed(t: RefreshedTokens): void;
  onGrantDead(reason: GrantDeathReason): void;
  /** E2E: when this returns a token, no network call is ever made. */
  fakeAccessToken?(): string | null;
  now?(): number;
}

/**
 * Classify an invalid_grant by how old the refresh token is. 6–8 days brackets
 * the 7-day Testing-mode expiry with a day of slack on either side, which is
 * wide enough for clock skew and narrow enough that a genuine revocation
 * (which happens at an arbitrary age) rarely lands inside it.
 */
export function classifyGrantDeath(obtainedAt: string | null, now: number): GrantDeathReason {
  if (!obtainedAt) return 'invalid_grant';
  const age = now - Date.parse(obtainedAt);
  if (!Number.isFinite(age)) return 'invalid_grant';
  return age >= TESTING_MODE_MIN_MS && age <= TESTING_MODE_MAX_MS ? 'expired_testing_mode' : 'invalid_grant';
}

export class TokenManager {
  /** The shared promise that makes refresh single-flight. */
  private inflight: Promise<string> | null = null;

  constructor(private readonly deps: TokenManagerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** True while a refresh is in progress — exposed for tests and diagnostics. */
  get refreshing(): boolean {
    return this.inflight !== null;
  }

  async getAccessToken(): Promise<string> {
    const fake = this.deps.fakeAccessToken?.();
    if (fake) return fake;

    const c = this.deps.read();
    if (!c) throw new AuthError('no_credentials', 'BoardTasks has no Google credentials yet.');
    if (!c.refreshToken) throw new AuthError('not_authenticated', 'Sign in to Google to sync your tasks.');

    if (c.accessToken && c.accessTokenExpiresAt) {
      const remaining = Date.parse(c.accessTokenExpiresAt) - this.now();
      if (Number.isFinite(remaining) && remaining > REFRESH_SKEW_MS) return c.accessToken;
    }
    return this.forceRefresh();
  }

  /**
   * Single-flight. On cold start the pull, the outbox flush and a UI fetch all
   * demand a token at once; three parallel refreshes burn three grants against
   * Google's per-account cap and can interleave so an older token overwrites a
   * newer one. Everyone waits on one promise instead.
   */
  forceRefresh(): Promise<string> {
    this.inflight ??= this.run();
    return this.inflight;
  }

  private async run(): Promise<string> {
    try {
      const fake = this.deps.fakeAccessToken?.();
      if (fake) return fake;

      const c = this.deps.read();
      if (!c) throw new AuthError('no_credentials', 'BoardTasks has no Google credentials yet.');
      if (!c.refreshToken) throw new AuthError('not_authenticated', 'Sign in to Google to sync your tasks.');

      let res: TokenResponse;
      try {
        res = await refreshAccessToken({ clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refreshToken });
      } catch (e) {
        if (e instanceof GoogleOAuthError && e.error === 'invalid_grant') {
          const reason = classifyGrantDeath(c.obtainedAt, this.now());
          log.warn(`refresh rejected: invalid_grant (${reason})`);
          this.deps.onGrantDead(reason);
          throw new AuthError('invalid_grant', describeOAuthError(e));
        }
        if (e instanceof GoogleOAuthError) throw new AuthError('unauthorized', describeOAuthError(e));
        throw e;
      }

      const refreshed: RefreshedTokens = {
        accessToken: res.accessToken,
        accessTokenExpiresAt: new Date(this.now() + res.expiresInSec * 1000).toISOString(),
        refreshToken: res.refreshToken,
        scope: res.scope,
      };
      log.info(`access token refreshed (expires in ${res.expiresInSec}s)`);
      this.deps.onRefreshed(refreshed);
      return refreshed.accessToken;
    } finally {
      this.inflight = null;
    }
  }

  /** Called by the API layer when Google says the grant is dead (401 + invalid_grant). */
  handleInvalidGrant(): void {
    const c = this.deps.read();
    this.deps.onGrantDead(classifyGrantDeath(c?.obtainedAt ?? null, this.now()));
  }
}
