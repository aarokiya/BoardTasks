import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn(), openExternal: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  net: { fetch: h.fetch },
  shell: { openExternal: h.openExternal },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));

import { GOOGLE_TASKS_SCOPE } from '../../../../src/shared/constants';
import { codeChallenge } from '../../../../src/main/auth/pkce';
import { buildAuthorizeUrl, startOAuthFlow } from '../../../../src/main/auth/oauth-flow';
import { GoogleOAuthError } from '../../../../src/main/auth/token-endpoint';

const CLIENT = { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' };

beforeEach(() => {
  h.fetch.mockReset();
  h.openExternal.mockReset();
  h.openExternal.mockResolvedValue(undefined);
});

/** Waits for the flow to open the browser and returns the authorize URL it asked for. */
function capturedAuthorizeUrl(): Promise<URL> {
  return vi.waitFor(() => {
    const call = h.openExternal.mock.calls[0];
    if (!call) throw new Error('browser not opened yet');
    return new URL(call[0] as string);
  });
}

describe('buildAuthorizeUrl', () => {
  it('asks for exactly what an installed app needs', () => {
    const u = new URL(
      buildAuthorizeUrl({ clientId: CLIENT.clientId, redirectUri: 'http://127.0.0.1:1234/callback', codeChallenge: 'CHAL', state: 'ST' }),
    );
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: CLIENT.clientId,
      redirect_uri: 'http://127.0.0.1:1234/callback',
      response_type: 'code',
      scope: GOOGLE_TASKS_SCOPE,
      code_challenge: 'CHAL',
      code_challenge_method: 'S256',
      state: 'ST',
      access_type: 'offline',
      prompt: 'consent',
    });
    // Only the tasks scope: adding `openid email` would widen the consent screen.
    expect(u.searchParams.get('scope')).not.toContain('openid');
  });
});

describe('startOAuthFlow', () => {
  it('runs the whole loopback round trip and redeems the code with the matching verifier', async () => {
    h.fetch.mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ access_token: 'ya29.new', refresh_token: '1//new', expires_in: 3599, scope: GOOGLE_TASKS_SCOPE })),
    });

    const flow = startOAuthFlow({ ...CLIENT, openUrl: (url) => h.openExternal(url) as Promise<void> });
    const authorize = await capturedAuthorizeUrl();
    const redirectUri = authorize.searchParams.get('redirect_uri') ?? '';
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const res = await fetch(`${redirectUri}?code=the-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`);
    await res.text();

    await expect(flow.tokens).resolves.toEqual({ accessToken: 'ya29.new', refreshToken: '1//new', expiresInSec: 3599, scope: GOOGLE_TASKS_SCOPE });

    const [url, init] = h.fetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(init.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('redirect_uri')).toBe(redirectUri);
    expect(form.get('client_secret')).toBe(CLIENT.clientSecret);
    // The verifier we present must be the pre-image of the challenge we sent.
    expect(codeChallenge(form.get('code_verifier') ?? '')).toBe(authorize.searchParams.get('code_challenge'));
  });

  it('surfaces a token-endpoint rejection with Google’s own description', async () => {
    h.fetch.mockResolvedValue({
      status: 401,
      text: () => Promise.resolve('{"error":"invalid_client","error_description":"The OAuth client was not found."}'),
    });

    const flow = startOAuthFlow({ ...CLIENT, openUrl: (url) => h.openExternal(url) as Promise<void> });
    const authorize = await capturedAuthorizeUrl();
    const redirectUri = authorize.searchParams.get('redirect_uri') ?? '';
    await (await fetch(`${redirectUri}?code=c&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`)).text();

    const e = await flow.tokens.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GoogleOAuthError);
    expect((e as GoogleOAuthError).error).toBe('invalid_client');
    expect((e as GoogleOAuthError).errorDescription).toBe('The OAuth client was not found.');
  });

  it('cancel() aborts the flow and frees the loopback port', async () => {
    const flow = startOAuthFlow({ ...CLIENT, openUrl: (url) => h.openExternal(url) as Promise<void> });
    const authorize = await capturedAuthorizeUrl();
    const redirectUri = authorize.searchParams.get('redirect_uri') ?? '';
    flow.cancel();
    await expect(flow.tokens).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(fetch(redirectUri)).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('cancelling before the browser opens still tears the listener down', async () => {
    h.openExternal.mockImplementation(() => new Promise(() => undefined)); // never resolves
    const flow = startOAuthFlow({ ...CLIENT, openUrl: (url) => h.openExternal(url) as Promise<void> });
    flow.cancel();
    await expect(flow.tokens).rejects.toMatchObject({ reason: 'cancelled' });
  });
});
