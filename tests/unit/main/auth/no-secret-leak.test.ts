import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { TokenResponse } from '../../../../src/main/auth/token-endpoint';

/**
 * A refresh token is the whole grant: with it, anything can mint access tokens
 * until the user revokes it by hand. It must never cross the IPC boundary, land
 * in an emitted event, or reach disk unencrypted. This test asserts that over
 * the entire auth IPC surface rather than one response at a time, so a new
 * field on AuthStatus cannot quietly carry one out.
 */
const REFRESH = '1//0gVeryLongRefreshTokenValue_abcdef123456';
const ACCESS = 'ya29.a0AfH6SMBAccessTokenValue-1234567890';
const SECRET = 'GOCSPX-TheClientSecretValue';
const CLIENT_ID = '123456789012-abcdefghijklmnopqrst.apps.googleusercontent.com';
const SECRETS = [REFRESH, ACCESS, SECRET];

const h = vi.hoisted(() => ({
  userData: '',
  emitted: [] as unknown[],
  fetch: vi.fn(),
  startOAuthFlow: vi.fn(),
  resolveFlow: null as ((t: TokenResponse) => void) | null,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.userData, getVersion: () => '0' },
  net: { fetch: h.fetch },
  shell: { openExternal: () => Promise.resolve() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // A reversible "encryption" so the test can prove the blob on disk is not
    // the plaintext JSON, while still being able to read it back.
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b.toString('utf8').slice('enc:'.length), 'base64').toString('utf8'),
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));
vi.mock('../../../../src/main/auth/oauth-flow', () => ({ startOAuthFlow: h.startOAuthFlow }));
vi.mock('../../../../src/main/ipc/emitter', () => ({
  emit: (e: unknown) => h.emitted.push(e),
  emitDataChanged: vi.fn(),
  flushEmitter: vi.fn(),
}));
vi.mock('../../../../src/main/db/wipe', () => ({ wipeLocalData: vi.fn() }));

function expectNoSecrets(label: string, text: string): void {
  for (const s of SECRETS) expect(text, `${label} leaked ${s.slice(0, 10)}…`).not.toContain(s);
}

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'bt-leak-'));
  h.emitted = [];
  h.fetch.mockReset();
  h.fetch.mockResolvedValue({ status: 200, text: () => Promise.resolve('{}') });
  h.startOAuthFlow.mockReset();
  h.startOAuthFlow.mockImplementation(() => {
    const tokens = new Promise<TokenResponse>((res) => {
      h.resolveFlow = res;
    });
    return { tokens, cancel: vi.fn() };
  });
});

afterEach(() => {
  rmSync(h.userData, { recursive: true, force: true });
});

async function signedInService(): Promise<{ status: unknown; routes: Awaited<ReturnType<typeof buildAuthRoutes>> }> {
  vi.resetModules();
  const mod = await import('../../../../src/main/auth/auth-service');
  mod.resetAuthServiceForTests();
  const svc = mod.initAuthService();
  svc.setCredentials({ clientId: CLIENT_ID, clientSecret: SECRET });
  const p = svc.signIn();
  h.resolveFlow?.({ accessToken: ACCESS, refreshToken: REFRESH, expiresInSec: 3600, scope: 'tasks' });
  await p;
  return { status: svc.getStatus(), routes: await buildAuthRoutes() };
}

async function buildAuthRoutes() {
  const { authRoutes } = await import('../../../../src/main/ipc/routes/auth');
  return authRoutes();
}

const fakeEvent = {} as IpcMainInvokeEvent;

describe('auth never leaks a secret to the renderer', () => {
  it('keeps tokens and the client secret out of AuthStatus', async () => {
    const { status } = await signedInService();
    expectNoSecrets('getStatus()', JSON.stringify(status));
    // The hint is the tail of the client *id*, which is not a secret.
    expect((status as { clientIdHint: string | null }).clientIdHint).toBe(CLIENT_ID.slice(-12));
    expect((status as { state: string }).state).toBe('signed_in');
  });

  it('keeps them out of every auth route response', async () => {
    const { routes } = await signedInService();
    const responses: unknown[] = [
      await routes['auth:getStatus'].handle(undefined, fakeEvent),
      await routes['auth:cancelSignIn'].handle(undefined, fakeEvent),
      await routes['auth:signOut'].handle({ wipeLocalData: false }, fakeEvent),
      await routes['auth:clearCredentials'].handle(undefined, fakeEvent),
    ];
    for (const r of responses) expectNoSecrets('route response', JSON.stringify(r));
  });

  it('keeps them out of the auth:changed events pushed to every window', async () => {
    await signedInService();
    expect(h.emitted.length).toBeGreaterThan(0);
    expectNoSecrets('emitted events', JSON.stringify(h.emitted));
  });

  it('writes nothing readable to disk', async () => {
    await signedInService();
    for (const name of readdirSync(h.userData)) {
      const contents = readFileSync(join(h.userData, name), 'utf8');
      expectNoSecrets(`file ${name}`, contents);
    }
  });
});
