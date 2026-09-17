import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthStatus } from '../../../../src/shared/models';
import type { TokenResponse } from '../../../../src/main/auth/token-endpoint';

interface Deferred {
  opts: { clientId: string; clientSecret: string };
  resolve: (t: TokenResponse) => void;
  reject: (e: unknown) => void;
  cancel: () => void;
}

const h = vi.hoisted(() => ({
  userData: '',
  available: true,
  flows: [] as Deferred[],
  startOAuthFlow: vi.fn(),
  fetch: vi.fn(),
  emit: vi.fn(),
  wipeLocalData: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.userData, getVersion: () => '0' },
  net: { fetch: h.fetch },
  shell: { openExternal: () => Promise.resolve() },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').slice('enc:'.length),
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));
vi.mock('../../../../src/main/auth/oauth-flow', () => ({ startOAuthFlow: h.startOAuthFlow }));
vi.mock('../../../../src/main/ipc/emitter', () => ({ emit: h.emit, emitDataChanged: vi.fn(), flushEmitter: vi.fn() }));
vi.mock('../../../../src/main/db/wipe', () => ({ wipeLocalData: h.wipeLocalData }));

const CLIENT_ID = '123456789012-abcdefghijklmnopqrst.apps.googleusercontent.com';
const CREDS = { clientId: CLIENT_ID, clientSecret: 'GOCSPX-secretvalue' };

type Service = Awaited<ReturnType<typeof newService>>;

async function newService() {
  vi.resetModules();
  const mod = await import('../../../../src/main/auth/auth-service');
  mod.resetAuthServiceForTests();
  return mod.initAuthService();
}

/** Every auth:changed status pushed to the renderer, in order. */
function emittedStates(): string[] {
  return h.emit.mock.calls
    .map(([e]) => e as { type: string; status?: AuthStatus })
    .filter((e) => e.type === 'auth:changed')
    .map((e) => e.status?.state ?? '');
}

async function signedIn(): Promise<Service> {
  const svc = await newService();
  svc.setCredentials(CREDS);
  const p = svc.signIn();
  h.flows[h.flows.length - 1]?.resolve({ accessToken: 'ya29.first', refreshToken: '1//refresh', expiresInSec: 3600, scope: 'tasks' });
  await p;
  return svc;
}

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'bt-auth-'));
  h.available = true;
  h.flows.length = 0;
  h.emit.mockReset();
  h.wipeLocalData.mockReset();
  h.fetch.mockReset();
  h.fetch.mockResolvedValue({ status: 200, text: () => Promise.resolve('{}') });
  h.startOAuthFlow.mockReset();
  h.startOAuthFlow.mockImplementation((opts: { clientId: string; clientSecret: string }) => {
    let resolve!: (t: TokenResponse) => void;
    let reject!: (e: unknown) => void;
    const tokens = new Promise<TokenResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void tokens.catch(() => undefined);
    const entry: Deferred = {
      opts,
      resolve,
      reject,
      cancel: vi.fn(() => {
        reject(Object.assign(new Error('Sign-in was cancelled.'), { reason: 'cancelled' }));
      }),
    };
    h.flows.push(entry);
    return { tokens, cancel: entry.cancel };
  });
  delete process.env['BT_FAKE_AUTH'];
});

afterEach(() => {
  rmSync(h.userData, { recursive: true, force: true });
  delete process.env['BT_FAKE_AUTH'];
});

describe('auth service state machine', () => {
  it('starts at no_credentials with nothing stored', async () => {
    const svc = await newService();
    expect(svc.getStatus()).toEqual({ state: 'no_credentials', clientIdHint: null, account: null, reason: null, signedInAt: null });
  });

  it('setCredentials moves to signed_out and exposes only the last 12 chars of the client id', async () => {
    const svc = await newService();
    const s = svc.setCredentials(CREDS);
    expect(s.state).toBe('signed_out');
    expect(s.clientIdHint).toBe(CLIENT_ID.slice(-12));
    expect(s.clientIdHint).toHaveLength(12);
    expect(JSON.stringify(s)).not.toContain('GOCSPX');
    expect(emittedStates()).toEqual(['signed_out']);
  });

  it('a different client id invalidates tokens issued to the old one', async () => {
    const svc = await signedIn();
    expect(svc.getStatus().state).toBe('signed_in');
    const s = svc.setCredentials({ clientId: '999999999999-zzzzzzzzzzzz.apps.googleusercontent.com', clientSecret: 'GOCSPX-other' });
    expect(s.state).toBe('signed_out');
  });

  it('re-entering the same client id keeps the existing sign-in', async () => {
    const svc = await signedIn();
    expect(svc.setCredentials(CREDS).state).toBe('signed_in');
  });

  it('signIn publishes signing_in then signed_in, with an anonymous account', async () => {
    const svc = await newService();
    svc.setCredentials(CREDS);
    const p = svc.signIn();
    expect(svc.getStatus().state).toBe('signing_in');

    h.flows[0]?.resolve({ accessToken: 'ya29.a', refreshToken: '1//r', expiresInSec: 3600, scope: 'tasks' });
    const done = await p;
    expect(done.state).toBe('signed_in');
    // Only the tasks scope is requested, so Google never tells us who this is.
    expect(done.account).toEqual({ email: null, name: null });
    expect(done.signedInAt).not.toBeNull();
    expect(emittedStates()).toEqual(['signed_out', 'signing_in', 'signed_in']);
    expect(h.startOAuthFlow).toHaveBeenCalledWith({ clientId: CLIENT_ID, clientSecret: CREDS.clientSecret });
    await expect(svc.getAccessToken()).resolves.toBe('ya29.a');
  });

  it('refuses to sign in with no credentials', async () => {
    const svc = await newService();
    await expect(svc.signIn()).rejects.toMatchObject({ reason: 'no_credentials' });
    expect(h.startOAuthFlow).not.toHaveBeenCalled();
  });

  it('a failed sign-in falls back to signed_out and keeps the credentials', async () => {
    const svc = await newService();
    svc.setCredentials(CREDS);
    const p = svc.signIn();
    h.flows[0]?.reject(Object.assign(new Error('You declined access.'), { reason: 'cancelled' }));
    await expect(p).rejects.toThrow(/declined/);
    expect(svc.getStatus().state).toBe('signed_out');
    expect(svc.getStatus().clientIdHint).toBe(CLIENT_ID.slice(-12));
    expect(emittedStates()).toEqual(['signed_out', 'signing_in', 'signed_out']);
  });

  it('a second signIn cancels the first', async () => {
    const svc = await newService();
    svc.setCredentials(CREDS);
    const first = svc.signIn();
    const second = svc.signIn();
    expect(h.flows).toHaveLength(2);
    expect(h.flows[0]?.cancel).toHaveBeenCalledTimes(1);
    await expect(first).rejects.toThrow(/cancelled/);

    h.flows[1]?.resolve({ accessToken: 'ya29.b', refreshToken: '1//r2', expiresInSec: 3600, scope: null });
    await expect(second).resolves.toMatchObject({ state: 'signed_in' });
  });

  it('cancelSignIn aborts a pending flow and returns to signed_out', async () => {
    const svc = await newService();
    svc.setCredentials(CREDS);
    const p = svc.signIn();
    const s = svc.cancelSignIn();
    expect(s.state).toBe('signed_out');
    await expect(p).rejects.toThrow(/cancelled/);
  });

  it('rejects a sign-in that returns no refresh token, rather than half-connecting', async () => {
    const svc = await newService();
    svc.setCredentials(CREDS);
    const p = svc.signIn();
    h.flows[0]?.resolve({ accessToken: 'ya29.a', refreshToken: null, expiresInSec: 3600, scope: null });
    await expect(p).rejects.toThrow(/refresh token/);
    expect(svc.getStatus().state).toBe('signed_out');
  });
});

describe('auth service sign-out', () => {
  it('revokes at Google, clears the tokens and keeps the client id', async () => {
    const svc = await signedIn();
    h.fetch.mockClear();
    const s = await svc.signOut({ wipeLocalData: false });
    expect(s.state).toBe('signed_out');
    expect(s.clientIdHint).toBe(CLIENT_ID.slice(-12));
    const [url, init] = h.fetch.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/revoke');
    expect(new URLSearchParams(init.body).get('token')).toBe('1//refresh');
    expect(h.wipeLocalData).not.toHaveBeenCalled();
  });

  it('signs out locally even when revocation fails', async () => {
    const svc = await signedIn();
    h.fetch.mockRejectedValue(new Error('offline'));
    await expect(svc.signOut({ wipeLocalData: false })).resolves.toMatchObject({ state: 'signed_out' });
  });

  it('wipes local data only when asked', async () => {
    const svc = await signedIn();
    await svc.signOut({ wipeLocalData: true });
    expect(h.wipeLocalData).toHaveBeenCalledTimes(1);
  });

  it('clearCredentials returns to no_credentials', async () => {
    const svc = await signedIn();
    await expect(svc.clearCredentials()).resolves.toMatchObject({ state: 'no_credentials', clientIdHint: null });
  });
});

describe('auth service re-authentication', () => {
  it('invalid_grant clears the tokens, keeps the client id and asks for re-auth', async () => {
    const svc = await signedIn();
    h.emit.mockClear();
    svc.handleInvalidGrant();
    const s = svc.getStatus();
    expect(s.state).toBe('reauth_required');
    expect(s.reason).toBe('invalid_grant');
    expect(s.clientIdHint).toBe(CLIENT_ID.slice(-12));
    expect(emittedStates()).toEqual(['reauth_required']);
    // The user is one click from signing back in — no trip to the Cloud console.
    const p = svc.signIn();
    expect(svc.getStatus().state).toBe('signing_in');
    svc.cancelSignIn();
    await expect(p).rejects.toThrow();
  });

  it('a refresh that fails with invalid_grant inside the 7-day window blames Testing mode', async () => {
    const svc = await signedIn();
    // Backdate the grant to 7 days old, then force a refresh that Google rejects.
    const store = await import('../../../../src/main/auth/credential-store');
    store.updateCredentials({
      obtainedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    h.fetch.mockResolvedValue({ status: 400, text: () => Promise.resolve('{"error":"invalid_grant"}') });

    await expect(svc.getAccessToken()).rejects.toMatchObject({ reason: 'invalid_grant' });
    expect(svc.getStatus()).toMatchObject({ state: 'reauth_required', reason: 'expired_testing_mode' });
  });

  it('an undecryptable blob surfaces as reauth_required/decrypt_failed', async () => {
    const svc = await signedIn();
    void svc;
    vi.resetModules();
    const { safeStorage } = await import('electron');
    const spy = vi.spyOn(safeStorage, 'decryptString').mockImplementation(() => {
      throw new Error('cannot decrypt');
    });
    const mod = await import('../../../../src/main/auth/auth-service');
    mod.resetAuthServiceForTests();
    const fresh = mod.initAuthService();
    expect(fresh.getStatus()).toMatchObject({ state: 'reauth_required', reason: 'decrypt_failed', clientIdHint: null });
    spy.mockRestore();
  });
});

describe('auth service without a keychain', () => {
  it('reports keychain_unavailable but still signs in for the session', async () => {
    h.available = false;
    const svc = await newService();
    expect(svc.setCredentials(CREDS).state).toBe('keychain_unavailable');

    const p = svc.signIn();
    h.flows[0]?.resolve({ accessToken: 'ya29.mem', refreshToken: '1//mem', expiresInSec: 3600, scope: null });
    const s = await p;
    expect(s.state).toBe('keychain_unavailable');
    // signedInAt is how a consumer tells "usable session" from "needs sign-in".
    expect(s.signedInAt).not.toBeNull();
    await expect(svc.getAccessToken()).resolves.toBe('ya29.mem');
  });
});

describe('auth service BT_FAKE_AUTH seam', () => {
  it('reports signed_in, serves the fake token and never persists anything', async () => {
    process.env['BT_FAKE_AUTH'] = JSON.stringify({ accessToken: 'e2e-access', refreshToken: 'e2e-refresh' });
    const svc = await newService();
    expect(svc.getStatus().state).toBe('signed_in');
    await expect(svc.getAccessToken()).resolves.toBe('e2e-access');
    await expect(svc.forceRefresh()).resolves.toBe('e2e-access');
    expect(h.fetch).not.toHaveBeenCalled();
    await expect(svc.signIn()).resolves.toMatchObject({ state: 'signed_in' });
    expect(h.startOAuthFlow).not.toHaveBeenCalled();
  });

  it('ignores a malformed BT_FAKE_AUTH instead of crashing startup', async () => {
    process.env['BT_FAKE_AUTH'] = '{"accessToken":"missing-refresh"}';
    const svc = await newService();
    expect(svc.getStatus().state).toBe('no_credentials');
  });
});
