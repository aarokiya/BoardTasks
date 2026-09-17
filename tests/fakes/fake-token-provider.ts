import type { AuthStatus } from '../../src/shared/models';
import { AuthError, type TokenProvider } from '../../src/main/auth/types';

export interface FakeTokenProvider extends TokenProvider {
  /** How many times a token was handed out / refreshed. */
  readonly calls: { get: number; refresh: number; invalidGrant: number };
  token: string;
  /** Make the next N getAccessToken calls throw. */
  failNextGet(error: unknown, times?: number): void;
  /** Make the next N forceRefresh calls throw. */
  failNextRefresh(error: unknown, times?: number): void;
  setState(state: AuthStatus['state'], reason?: AuthStatus['reason']): void;
}

export function createFakeTokenProvider(initial = 'ya29.test-token'): FakeTokenProvider {
  const calls = { get: 0, refresh: 0, invalidGrant: 0 };
  const listeners = new Set<(s: AuthStatus) => void>();
  let status: AuthStatus = { state: 'signed_in', clientIdHint: 'fake', account: null, reason: null, signedInAt: '2026-09-17T00:00:00.000Z' };
  const getFailures: unknown[] = [];
  const refreshFailures: unknown[] = [];

  const provider: FakeTokenProvider = {
    calls,
    token: initial,
    getAccessToken() {
      calls.get++;
      const f = getFailures.shift();
      if (f) return Promise.reject(f);
      if (status.state !== 'signed_in') return Promise.reject(new AuthError('not_authenticated'));
      return Promise.resolve(provider.token);
    },
    forceRefresh() {
      calls.refresh++;
      const f = refreshFailures.shift();
      if (f) return Promise.reject(f);
      provider.token = `${initial}-r${calls.refresh}`;
      return Promise.resolve(provider.token);
    },
    getStatus: () => status,
    onStatusChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    handleInvalidGrant() {
      calls.invalidGrant++;
      provider.setState('reauth_required', 'invalid_grant');
    },
    failNextGet(error, times = 1) {
      for (let i = 0; i < times; i++) getFailures.push(error);
    },
    failNextRefresh(error, times = 1) {
      for (let i = 0; i < times; i++) refreshFailures.push(error);
    },
    setState(state, reason = null) {
      status = { ...status, state, reason };
      for (const cb of [...listeners]) cb(status);
    },
  };
  return provider;
}
