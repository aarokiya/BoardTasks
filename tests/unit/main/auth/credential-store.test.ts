import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as CredentialStore from '../../../../src/main/auth/credential-store';

const h = vi.hoisted(() => ({ userData: '', available: true, decryptThrows: false }));

// A fake Keychain: encryptString/decryptString are a reversible prefix so the
// test can inspect what actually landed on disk.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.userData, getVersion: () => '0' },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      if (h.decryptThrows) throw new Error('keychain item is not decryptable');
      return b.toString('utf8').slice('enc:'.length);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));

/** Fresh module graph: also resets secure-store's in-memory cache, which is what forces a real disk read. */
async function load(): Promise<typeof CredentialStore> {
  vi.resetModules();
  return import('../../../../src/main/auth/credential-store');
}

const CREDS = {
  version: 1 as const,
  clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-supersecretvalue',
  refreshToken: '1//0aRefreshTokenValueThatIsLong',
  accessToken: 'ya29.AccessTokenValue',
  accessTokenExpiresAt: '2026-09-17T12:00:00.000Z',
  scope: 'https://www.googleapis.com/auth/tasks',
  obtainedAt: '2026-09-17T11:00:00.000Z',
  accountEmail: null,
};

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'bt-creds-'));
  h.available = true;
  h.decryptThrows = false;
});

afterEach(() => {
  rmSync(h.userData, { recursive: true, force: true });
});

const blobPath = (): string => join(h.userData, 'google-credentials.enc');

describe('credential store (keychain available)', () => {
  it('round-trips one JSON blob through safeStorage', async () => {
    const a = await load();
    a.writeCredentials(CREDS);
    expect(existsSync(blobPath())).toBe(true);

    const b = await load();
    const snap = b.readCredentials();
    expect(snap.decryptFailed).toBe(false);
    expect(snap.persistent).toBe(true);
    expect(snap.credentials).toEqual(CREDS);
  });

  it('stores client id + secret with no tokens (credentials set, not yet signed in)', async () => {
    const a = await load();
    a.writeCredentials({ ...CREDS, refreshToken: null, accessToken: null, accessTokenExpiresAt: null, obtainedAt: null, scope: null });
    const snap = (await load()).readCredentials();
    expect(snap.credentials?.clientId).toBe(CREDS.clientId);
    expect(snap.credentials?.refreshToken).toBeNull();
  });

  it('clearTokens keeps the client id and secret so sign-in is one click away', async () => {
    const a = await load();
    a.writeCredentials(CREDS);
    const after = a.clearTokens();
    expect(after).toMatchObject({ clientId: CREDS.clientId, clientSecret: CREDS.clientSecret, refreshToken: null, accessToken: null, obtainedAt: null });
    expect((await load()).readCredentials().credentials?.clientSecret).toBe(CREDS.clientSecret);
  });

  it('updateCredentials patches in place and is a no-op with nothing stored', async () => {
    const a = await load();
    expect(a.updateCredentials({ accessToken: 'x' })).toBeNull();
    a.writeCredentials(CREDS);
    a.updateCredentials({ accessToken: 'ya29.Rotated', accessTokenExpiresAt: '2026-09-17T13:00:00.000Z' });
    const snap = (await load()).readCredentials();
    expect(snap.credentials?.accessToken).toBe('ya29.Rotated');
    expect(snap.credentials?.refreshToken).toBe(CREDS.refreshToken);
  });

  it('clearCredentials removes the blob from disk', async () => {
    const a = await load();
    a.writeCredentials(CREDS);
    a.clearCredentials();
    expect(existsSync(blobPath())).toBe(false);
    expect((await load()).readCredentials().credentials).toBeNull();
  });

  it('treats an unparseable blob as absent without destroying it', async () => {
    const a = await load();
    a.writeCredentials(CREDS);
    writeFileSync(blobPath(), Buffer.from('enc:{"version":99,"nope":true}', 'utf8'));
    const snap = (await load()).readCredentials();
    expect(snap.credentials).toBeNull();
    expect(snap.decryptFailed).toBe(false);
    expect(existsSync(blobPath())).toBe(true);
  });
});

describe('credential store (keychain unavailable)', () => {
  it('never falls back to plaintext and reports persistent: false', async () => {
    h.available = false;
    const a = await load();
    a.writeCredentials(CREDS);
    expect(existsSync(blobPath())).toBe(false);
    // Still usable for this session — sign-in must keep working without a keychain.
    const snap = a.readCredentials();
    expect(snap.credentials).toEqual(CREDS);
    expect(snap.persistent).toBe(false);
  });

  it('loses the credentials on restart, as designed', async () => {
    h.available = false;
    (await load()).writeCredentials(CREDS);
    expect((await load()).readCredentials().credentials).toBeNull();
  });
});

describe('credential store (undecryptable blob)', () => {
  it('reports decrypt_failed instead of pretending there are no credentials', async () => {
    const a = await load();
    a.writeCredentials(CREDS);
    h.decryptThrows = true;

    const snap = (await load()).readCredentials();
    expect(snap.decryptFailed).toBe(true);
    expect(snap.credentials).toBeNull();
  });

  it('clears the decrypt_failed flag once new credentials are written', async () => {
    const a = await load();
    a.writeCredentials(CREDS);
    h.decryptThrows = true;
    const b = await load();
    expect(b.readCredentials().decryptFailed).toBe(true);
    h.decryptThrows = false;
    b.writeCredentials({ ...CREDS, refreshToken: null });
    expect(b.readCredentials().decryptFailed).toBe(false);
  });
});

describe('session-only credentials (BT_FAKE_AUTH seam)', () => {
  it('holds them in memory and never touches disk', async () => {
    const a = await load();
    a.seedSessionCredentials(CREDS);
    expect(a.isSessionOnly()).toBe(true);
    expect(a.readCredentials().credentials).toEqual(CREDS);
    a.updateCredentials({ accessToken: 'ya29.Another' });
    expect(existsSync(blobPath())).toBe(false);
  });
});
