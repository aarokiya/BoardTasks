import type { AuthStatus } from '@shared/models';

/**
 * Contract between the auth module and everything that needs a token.
 * Implemented by src/main/auth/auth-service.ts; consumed by the API client.
 */
export interface TokenProvider {
  /** Resolves a valid access token, refreshing proactively. Throws AuthError('not_authenticated'|'invalid_grant'). */
  getAccessToken(): Promise<string>;
  /** Force a refresh (after a 401). Single-flight. */
  forceRefresh(): Promise<string>;
  /** Current status snapshot. */
  getStatus(): AuthStatus;
  /** Subscribe to status changes. */
  onStatusChanged(cb: (s: AuthStatus) => void): () => void;
  /** Called by the API layer when Google says the grant is dead. */
  handleInvalidGrant(): void;
}

export class AuthError extends Error {
  readonly kind = 'auth' as const;
  readonly retryable = false;
  constructor(
    readonly reason: 'not_authenticated' | 'invalid_grant' | 'unauthorized' | 'insufficient_scope' | 'no_credentials' | 'cancelled' | 'timeout' | 'state_mismatch' | 'decrypt_failed',
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'AuthError';
  }
}
