import { shell } from 'electron';
import { GOOGLE_TASKS_SCOPE } from '@shared/constants';
import { createLogger } from '../logger';
import { codeChallenge, createCodeVerifier, createState } from './pkce';
import { startLoopbackServer, type LoopbackServer } from './loopback-server';
import { authorizeEndpoint, exchangeCode, type TokenResponse } from './token-endpoint';
import { AuthError } from './types';

const log = createLogger('auth');

export interface OAuthFlowOptions {
  clientId: string;
  clientSecret: string;
  /** Injectable for tests. Defaults to the system browser. */
  openUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export interface OAuthFlowHandle {
  /** Resolves with the token set, or rejects with AuthError / GoogleOAuthError / OAuthNetworkError. */
  readonly tokens: Promise<TokenResponse>;
  /** Idempotent. Rejects `tokens` with AuthError('cancelled') if it has not settled. */
  cancel(): void;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const u = new URL(authorizeEndpoint());
  u.search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: GOOGLE_TASKS_SCOPE,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
    // A refresh token is only issued with access_type=offline, and Google only
    // re-issues one when consent is re-granted — so prompt=consent, every time.
    // Without it a second sign-in returns an access token and no refresh token,
    // and the app silently loses the ability to sync in the background.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  }).toString();
  return u.toString();
}

/**
 * Authorization Code + PKCE S256 in the SYSTEM BROWSER.
 *
 * Never a BrowserWindow: Google blocks embedded user agents outright, and an
 * embedded window can read the user's password — precisely the trust violation
 * OAuth exists to prevent.
 */
export function startOAuthFlow(opts: OAuthFlowOptions): OAuthFlowHandle {
  let server: LoopbackServer | null = null;
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    server?.cancel();
  };

  const tokens = (async (): Promise<TokenResponse> => {
    const verifier = createCodeVerifier();
    const state = createState();
    const listener = await startLoopbackServer({ state, timeoutMs: opts.timeoutMs });
    server = listener;
    // cancel() may have landed while we were binding the port.
    if (cancelled) {
      listener.close();
      throw new AuthError('cancelled', 'Sign-in was cancelled.');
    }
    try {
      const url = buildAuthorizeUrl({
        clientId: opts.clientId,
        redirectUri: listener.redirectUri,
        codeChallenge: codeChallenge(verifier),
        state,
      });
      log.info(`opening system browser for consent (redirect ${listener.redirectUri})`);
      const open = opts.openUrl ?? ((target: string) => shell.openExternal(target));
      await open(url);
      const code = await listener.code;
      log.info('authorization code received; exchanging for tokens');
      return await exchangeCode({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        code,
        codeVerifier: verifier,
        redirectUri: listener.redirectUri,
      });
    } finally {
      listener.close();
    }
  })();

  // Mark it handled: the flow can reject (cancel, timeout, Google saying no)
  // before the caller has attached its own handler, and an unhandledRejection
  // in the main process is a crash-adjacent event, not a warning.
  void tokens.catch(() => undefined);

  return { tokens, cancel };
}
