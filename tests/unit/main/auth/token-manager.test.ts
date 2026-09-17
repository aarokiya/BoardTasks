import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredCredentials } from '../../../../src/main/auth/credential-store';
import {
  TESTING_MODE_MAX_MS,
  TESTING_MODE_MIN_MS,
  TokenManager,
  classifyGrantDeath,
  type GrantDeathReason,
  type RefreshedTokens,
} from '../../../../src/main/auth/token-manager';
import { AuthError } from '../../../../src/main/auth/types';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  net: { fetch: h.fetch },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));

const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function creds(over: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    version: 1,
    clientId: '1-a.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-secret',
    refreshToken: '1//refresh',
    accessToken: 'ya29.old',
    accessTokenExpiresAt: new Date(NOW - 1000).toISOString(),
    scope: 'https://www.googleapis.com/auth/tasks',
    obtainedAt: new Date(NOW - DAY).toISOString(),
    accountEmail: null,
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): { status: number; text: () => Promise<string> } {
  return { status, text: () => Promise.resolve(JSON.stringify(body)) };
}

interface Harness {
  tm: TokenManager;
  refreshed: RefreshedTokens[];
  dead: GrantDeathReason[];
  current: StoredCredentials | null;
}

function harness(initial: StoredCredentials | null, fake?: string | null): Harness {
  const state: Harness = {
    refreshed: [],
    dead: [],
    current: initial,
    tm: undefined as unknown as TokenManager,
  };
  state.tm = new TokenManager({
    read: () => state.current,
    onRefreshed: (t) => state.refreshed.push(t),
    onGrantDead: (r) => state.dead.push(r),
    fakeAccessToken: () => fake ?? null,
    now: () => NOW,
  });
  return state;
}

beforeEach(() => {
  h.fetch.mockReset();
});

describe('classifyGrantDeath', () => {
  it.each([
    [null, 'invalid_grant'],
    [new Date(NOW - 2 * DAY).toISOString(), 'invalid_grant'],
    [new Date(NOW - TESTING_MODE_MIN_MS).toISOString(), 'expired_testing_mode'],
    [new Date(NOW - 7 * DAY).toISOString(), 'expired_testing_mode'],
    [new Date(NOW - TESTING_MODE_MAX_MS).toISOString(), 'expired_testing_mode'],
    [new Date(NOW - 30 * DAY).toISOString(), 'invalid_grant'],
    ['not-a-date', 'invalid_grant'],
  ])('%s → %s', (obtainedAt, expected) => {
    expect(classifyGrantDeath(obtainedAt, NOW)).toBe(expected);
  });
});

describe('token manager', () => {
  it('returns the cached access token when it is comfortably in the future', async () => {
    const hn = harness(creds({ accessTokenExpiresAt: new Date(NOW + 30 * 60 * 1000).toISOString(), accessToken: 'ya29.good' }));
    await expect(hn.tm.getAccessToken()).resolves.toBe('ya29.good');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('refreshes proactively inside the 5-minute skew window', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { access_token: 'ya29.fresh', expires_in: 3599 }));
    const hn = harness(creds({ accessTokenExpiresAt: new Date(NOW + 4 * 60 * 1000).toISOString() }));
    await expect(hn.tm.getAccessToken()).resolves.toBe('ya29.fresh');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(hn.refreshed[0]?.accessTokenExpiresAt).toBe(new Date(NOW + 3599 * 1000).toISOString());
  });

  it('sends grant_type=refresh_token with the client id and secret', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { access_token: 'ya29.fresh', expires_in: 3600 }));
    await harness(creds()).tm.forceRefresh();
    const [, init] = h.fetch.mock.calls[0] as [string, { body: string }];
    const form = new URLSearchParams(init.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('1//refresh');
    expect(form.get('client_id')).toBe('1-a.apps.googleusercontent.com');
    expect(form.get('client_secret')).toBe('GOCSPX-secret');
  });

  it('is single-flight: N concurrent demands produce exactly one refresh', async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => {
      release = r;
    });
    h.fetch.mockImplementation(async () => {
      await gate;
      return jsonResponse(200, { access_token: 'ya29.single', expires_in: 3600 });
    });

    const hn = harness(creds());
    const all = Promise.all(Array.from({ length: 8 }, () => hn.tm.getAccessToken()));
    expect(hn.tm.refreshing).toBe(true);
    release(null);
    await expect(all).resolves.toEqual(Array<string>(8).fill('ya29.single'));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(hn.refreshed).toHaveLength(1);
    expect(hn.tm.refreshing).toBe(false);
  });

  it('releases the single-flight slot after a failure so the next attempt retries', async () => {
    h.fetch.mockRejectedValueOnce(new Error('socket hang up'));
    const hn = harness(creds());
    await expect(hn.tm.forceRefresh()).rejects.toThrow(/Could not reach Google/);
    expect(hn.tm.refreshing).toBe(false);

    h.fetch.mockResolvedValue(jsonResponse(200, { access_token: 'ya29.second', expires_in: 3600 }));
    await expect(hn.tm.forceRefresh()).resolves.toBe('ya29.second');
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('stores a rotated refresh token when Google sends one', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { access_token: 'ya29.x', expires_in: 3600, refresh_token: '1//rotated', scope: 'scope-x' }));
    const hn = harness(creds());
    await hn.tm.forceRefresh();
    expect(hn.refreshed[0]).toMatchObject({ refreshToken: '1//rotated', scope: 'scope-x' });
  });

  it('invalid_grant clears the grant and reports reauth, keeping the client credentials', async () => {
    h.fetch.mockResolvedValue(jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    const hn = harness(creds({ obtainedAt: new Date(NOW - 60 * DAY).toISOString() }));
    const e = await hn.tm.forceRefresh().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect((e as AuthError).reason).toBe('invalid_grant');
    expect((e as AuthError).message).toContain('Token has been expired or revoked.');
    expect(hn.dead).toEqual(['invalid_grant']);
    // The manager never touches storage itself — clearing tokens is the service's job.
    expect(hn.current?.clientId).toBe('1-a.apps.googleusercontent.com');
  });

  it('flags the 7-day Testing-mode trap instead of a generic reauth', async () => {
    h.fetch.mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));
    const hn = harness(creds({ obtainedAt: new Date(NOW - 7 * DAY).toISOString() }));
    await expect(hn.tm.forceRefresh()).rejects.toBeInstanceOf(AuthError);
    expect(hn.dead).toEqual(['expired_testing_mode']);
  });

  it('maps invalid_client to an actionable unauthorized error, not a dead grant', async () => {
    h.fetch.mockResolvedValue(jsonResponse(401, { error: 'invalid_client', error_description: 'Unauthorized' }));
    const hn = harness(creds());
    const e = await hn.tm.forceRefresh().catch((x: unknown) => x);
    expect((e as AuthError).reason).toBe('unauthorized');
    expect((e as AuthError).message).toMatch(/client ID or client secret/);
    expect(hn.dead).toEqual([]);
  });

  it('handleInvalidGrant classifies from the stored obtainedAt', () => {
    const hn = harness(creds({ obtainedAt: new Date(NOW - 7 * DAY).toISOString() }));
    hn.tm.handleInvalidGrant();
    expect(hn.dead).toEqual(['expired_testing_mode']);
  });

  it('throws without credentials, and without a refresh token', async () => {
    await expect(harness(null).tm.getAccessToken()).rejects.toMatchObject({ reason: 'no_credentials' });
    await expect(harness(creds({ refreshToken: null })).tm.getAccessToken()).rejects.toMatchObject({ reason: 'not_authenticated' });
  });

  it('the E2E fake token short-circuits every network call', async () => {
    const hn = harness(creds({ accessTokenExpiresAt: new Date(NOW - DAY).toISOString() }), 'e2e-token');
    await expect(hn.tm.getAccessToken()).resolves.toBe('e2e-token');
    await expect(hn.tm.forceRefresh()).resolves.toBe('e2e-token');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('defaults a missing expires_in to an hour rather than NaN', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { access_token: 'ya29.x' }));
    const hn = harness(creds());
    await hn.tm.forceRefresh();
    expect(hn.refreshed[0]?.accessTokenExpiresAt).toBe(new Date(NOW + 3600 * 1000).toISOString());
  });
});
