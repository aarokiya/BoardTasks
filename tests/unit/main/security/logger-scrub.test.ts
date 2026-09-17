import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, registerSecret, scrub } from '../../../../src/main/logger';

/**
 * The scrubber is the last line of defence for the day somebody writes
 * `log.error('refresh failed', credentials)`. These are the real token shapes,
 * not placeholders: a test with a fake shape passes while the production shape
 * walks straight through.
 */
const GOOGLE_ACCESS = 'ya29.a0AfH6SMBxSecretAccessTokenValue-1234567890abcdef';
const GOOGLE_REFRESH = '1//0gL9ExampleRefreshTokenValue_abcdef123456';
const GOOGLE_SECRET = 'GOCSPX-AbCdEf0123456789xyzQ';
const GITHUB_CLASSIC = 'ghp_16charsAndMoreABCDEFGHIJKLMNOPQRSTUV12';
const GITHUB_FINE = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890ABCDEF';
const OPAQUE_BEARER = 'abc123def456ghi789jkl012mno345';
const AUTH_CODE = '4/0AeanS0aSecretAuthorizationCodeValue';
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiIxMjM0NSIsImVtYWlsIjoiYUBiLmNvIn0.SignatureBytesHere';

const ALL_SECRETS = [
  GOOGLE_ACCESS,
  GOOGLE_REFRESH,
  GOOGLE_SECRET,
  GITHUB_CLASSIC,
  GITHUB_FINE,
  OPAQUE_BEARER,
  AUTH_CODE,
  ID_TOKEN,
];

function expectClean(output: string, secrets: readonly string[] = ALL_SECRETS): void {
  for (const s of secrets) expect(output, `leaked ${s.slice(0, 8)}…`).not.toContain(s);
  expect(output).toContain('[REDACTED]');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scrub', () => {
  it('redacts every credential shape in a dumped object', () => {
    const dumped = JSON.stringify({
      clientId: '123456789012-abcdef.apps.googleusercontent.com',
      clientSecret: GOOGLE_SECRET,
      access_token: GOOGLE_ACCESS,
      refresh_token: GOOGLE_REFRESH,
      id_token: ID_TOKEN,
      githubToken: GITHUB_CLASSIC,
      githubFineGrained: GITHUB_FINE,
      headers: { Authorization: `Bearer ${OPAQUE_BEARER}` },
    });
    expectClean(scrub(dumped));
  });

  it('redacts a JSON token response verbatim', () => {
    const body = `{"access_token":"${GOOGLE_ACCESS}","expires_in":3599,"refresh_token":"${GOOGLE_REFRESH}","scope":"https://www.googleapis.com/auth/tasks","token_type":"Bearer"}`;
    const out = scrub(body);
    expectClean(out, [GOOGLE_ACCESS, GOOGLE_REFRESH]);
    // Non-secret context must survive, or the log stops being useful.
    expect(out).toContain('expires_in');
    expect(out).toContain('auth/tasks');
  });

  it('redacts Authorization headers of both schemes', () => {
    expectClean(scrub(`authorization: Bearer ${GOOGLE_ACCESS}`), [GOOGLE_ACCESS]);
    expectClean(scrub(`Authorization: Bearer ${OPAQUE_BEARER}`), [OPAQUE_BEARER]);
    expectClean(scrub('Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l'), ['YWxhZGRpbjpvcGVuc2VzYW1l']);
  });

  it('redacts secrets embedded in a URL query string', () => {
    const url = `https://oauth2.googleapis.com/token?client_secret=${GOOGLE_SECRET}&code=${AUTH_CODE}&access_token=${GOOGLE_ACCESS}&prompt=consent`;
    const out = scrub(url);
    expectClean(out, [GOOGLE_SECRET, AUTH_CODE, GOOGLE_ACCESS]);
    // The URL is still diagnosable: host, path and innocent params remain.
    expect(out).toContain('oauth2.googleapis.com/token');
    expect(out).toContain('prompt=consent');
  });

  it('redacts a token echoed inside a thrown net.fetch error, stack and all', () => {
    const e = new Error(
      `request to https://tasks.googleapis.com/tasks/v1/users/@me/lists?access_token=${GOOGLE_ACCESS} failed, reason: ECONNRESET`,
    );
    const rendered = `${e.name}: ${e.message}\n${e.stack ?? ''}`;
    const out = scrub(rendered);
    expectClean(out, [GOOGLE_ACCESS]);
    expect(out).toContain('ECONNRESET');
  });

  it('keeps non-secret diagnostics readable', () => {
    const line = "request failed { code: 'ENOTFOUND', status: 404, statusCode: 429 }";
    expect(scrub(line)).toBe(line);
  });

  it('redacts a value registered with registerSecret even when it has no recognisable shape', () => {
    const odd = 'zzz-not-a-known-token-shape-zzz';
    expect(scrub(odd)).toBe(odd);
    registerSecret(odd);
    expect(scrub(odd)).toBe('[REDACTED]');
  });
});

describe('createLogger', () => {
  it('scrubs on the way to the console, not only in scrub()', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createLogger('test').error('credentials', {
      clientSecret: GOOGLE_SECRET,
      refresh_token: GOOGLE_REFRESH,
      access_token: GOOGLE_ACCESS,
      pat: GITHUB_FINE,
    });
    const line = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('[test]');
    expectClean(line, [GOOGLE_SECRET, GOOGLE_REFRESH, GOOGLE_ACCESS, GITHUB_FINE]);
  });
});
