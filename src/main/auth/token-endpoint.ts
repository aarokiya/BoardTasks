import { net } from 'electron';
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
} from '@shared/constants';
import { googleBaseUrl } from '../env';
import { createLogger, registerSecret } from '../logger';

const log = createLogger('auth');

/**
 * All Google OAuth HTTP lives here, on Electron's `net.fetch` rather than the
 * global one: net.fetch goes through Chromium's network stack, so system
 * proxies, PAC scripts and enterprise CA roots work without extra config.
 *
 * BT_GOOGLE_BASE_URL redirects the token/revoke endpoints at the E2E fake
 * Google server. The authorize endpoint follows it too, so a harness can serve
 * a consent page; in E2E the BT_FAKE_AUTH seam normally bypasses the flow.
 */
export function authorizeEndpoint(): string {
  return googleBaseUrl ? `${googleBaseUrl}/oauth/auth` : GOOGLE_AUTH_ENDPOINT;
}
export function tokenEndpoint(): string {
  return googleBaseUrl ? `${googleBaseUrl}/oauth/token` : GOOGLE_TOKEN_ENDPOINT;
}
export function revokeEndpoint(): string {
  return googleBaseUrl ? `${googleBaseUrl}/oauth/revoke` : GOOGLE_REVOKE_ENDPOINT;
}

/** Google answered, and said no. `error` is its machine-readable code. */
export class GoogleOAuthError extends Error {
  constructor(
    readonly error: string,
    readonly errorDescription: string | null,
    readonly status: number,
  ) {
    super(errorDescription ? `${error}: ${errorDescription}` : error);
    this.name = 'GoogleOAuthError';
  }
}

/** We never reached Google. Always worth retrying. */
export class OAuthNetworkError extends Error {
  readonly retryable = true;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'OAuthNetworkError';
  }
}

export interface TokenResponse {
  accessToken: string;
  /** Absent on a refresh unless Google rotated it. */
  refreshToken: string | null;
  expiresInSec: number;
  scope: string | null;
}

function readErrorBody(body: unknown, raw: string, status: number): GoogleOAuthError {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const code = typeof o['error'] === 'string' ? o['error'] : null;
    const desc = typeof o['error_description'] === 'string' ? o['error_description'] : null;
    if (code) return new GoogleOAuthError(code, desc, status);
  }
  return new GoogleOAuthError(`http_${status}`, raw.slice(0, 200) || null, status);
}

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  let raw: string;
  let status: number;
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    status = res.status;
    raw = await res.text();
  } catch (e) {
    throw new OAuthNetworkError('Could not reach Google. Check your internet connection and try again.', e);
  }
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = null;
    }
  }
  if (status < 200 || status >= 300) throw readErrorBody(body, raw, status);
  return body;
}

function parseTokenResponse(body: unknown): TokenResponse {
  if (!body || typeof body !== 'object') {
    throw new GoogleOAuthError('invalid_response', 'Google returned an unreadable token response.', 200);
  }
  const o = body as Record<string, unknown>;
  const accessToken = typeof o['access_token'] === 'string' ? o['access_token'] : null;
  if (!accessToken) {
    throw new GoogleOAuthError('invalid_response', 'Google returned a token response without an access token.', 200);
  }
  const refreshToken = typeof o['refresh_token'] === 'string' ? o['refresh_token'] : null;
  const expiresIn = typeof o['expires_in'] === 'number' ? o['expires_in'] : Number(o['expires_in']);
  registerSecret(accessToken);
  registerSecret(refreshToken);
  return {
    accessToken,
    refreshToken,
    // Google sends 3599; a missing/garbage value must not become NaN and make
    // every token look permanently expired (or permanently valid).
    expiresInSec: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 3600,
    scope: typeof o['scope'] === 'string' ? o['scope'] : null,
  };
}

export async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = await postForm(tokenEndpoint(), {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
  });
  return parseTokenResponse(body);
}

export async function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const body = await postForm(tokenEndpoint(), {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: 'refresh_token',
  });
  return parseTokenResponse(body);
}

/** Best-effort: the caller logs and carries on, because local sign-out must always succeed. */
export async function revokeToken(token: string): Promise<void> {
  await postForm(revokeEndpoint(), { token });
  log.info('revoked token at Google');
}

/**
 * Turns Google's machine codes into something a user can act on. The raw
 * error_description is always appended — it is usually the only thing that
 * distinguishes "wrong secret" from "wrong redirect URI".
 */
export function describeOAuthError(e: GoogleOAuthError): string {
  const detail = e.errorDescription ? ` (${e.errorDescription})` : '';
  switch (e.error) {
    case 'invalid_client':
      return `Google rejected your client ID or client secret. Re-copy both from the Google Cloud console.${detail}`;
    case 'unauthorized_client':
      return `This OAuth client is not allowed to use this sign-in method. Make sure you created a "Desktop app" client.${detail}`;
    case 'invalid_grant':
      return `Google will not renew this sign-in. Sign in again.${detail}`;
    case 'redirect_uri_mismatch':
      return `Google rejected the local redirect address. A "Desktop app" OAuth client is required — "Web application" will not work.${detail}`;
    case 'invalid_scope':
      return `Google rejected the requested permission. Enable the Google Tasks API for your project.${detail}`;
    case 'access_denied':
      return `Access was declined, so BoardTasks was not connected.${detail}`;
    case 'invalid_request':
      return `Google rejected the sign-in request.${detail}`;
    default:
      return `Google returned an error: ${e.error}${detail}`;
  }
}
