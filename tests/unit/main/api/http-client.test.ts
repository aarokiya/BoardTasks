import { describe, expect, it } from 'vitest';
import { ApiError, ConflictError, NetworkError, RateLimitError } from '../../../../src/main/api/errors';
import { createHttpClient, parseRetryAfter, type FetchInit, type FetchLike } from '../../../../src/main/api/http-client';
import { AuthError } from '../../../../src/main/auth/types';
import { createFakeClock, createFakeRandom, T0 } from '../../../fakes/fake-clock';
import { createSilentLogger } from '../../../fakes/fake-network';
import { createFakeTokenProvider } from '../../../fakes/fake-token-provider';

interface Scripted {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: unknown;
}

interface Recorder {
  fetch: FetchLike;
  calls: Array<{ url: string; init: FetchInit }>;
}

function scriptedFetch(responses: Scripted[]): Recorder {
  const calls: Array<{ url: string; init: FetchInit }> = [];
  let i = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (!r) throw new Error('no scripted response');
    if (r.throws) return Promise.reject(r.throws);
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return Promise.resolve({
      status: r.status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: () => Promise.resolve(r.body === undefined ? '' : JSON.stringify(r.body)),
    });
  };
  return { fetch, calls };
}

function googleError(reason: string, message = 'boom'): unknown {
  return { error: { code: 403, message, status: reason, errors: [{ domain: 'usageLimits', reason, message }] } };
}

function makeClient(responses: Scripted[], over: { idempotentMax?: number } = {}) {
  const clock = createFakeClock();
  const rec = scriptedFetch(responses);
  const tokens = createFakeTokenProvider();
  const client = createHttpClient({
    baseUrl: 'https://tasks.example/tasks/v1',
    fetch: rec.fetch,
    tokens,
    clock,
    random: createFakeRandom(0.5),
    logger: createSilentLogger(),
    maxAttempts: over.idempotentMax ?? 5,
  });
  return { client, clock, tokens, rec };
}

const GET = { method: 'GET' as const, path: '/users/@me/lists', idempotent: true };
const POST = { method: 'POST' as const, path: '/lists/L/tasks', idempotent: false, body: { title: 'x' } };

describe('http-client request shape', () => {
  it('sends the bearer token, encodes query and clears the timeout', async () => {
    const { client, clock, rec } = makeClient([{ status: 200, body: { items: [] }, headers: { date: 'Thu, 17 Sep 2026 12:00:00 GMT' } }]);
    const r = await client.request({ ...GET, query: { maxResults: 100, pageToken: undefined, q: 'a b' } });
    expect(rec.calls[0]!.url).toBe('https://tasks.example/tasks/v1/users/@me/lists?maxResults=100&q=a%20b');
    expect(rec.calls[0]!.init.headers['authorization']).toBe('Bearer ya29.test-token');
    expect(r.serverDate).toBe('Thu, 17 Sep 2026 12:00:00 GMT');
    // The 30s abort timer must not be left armed, or it keeps the app alive.
    expect(clock.pending()).toBe(0);
  });

  it('records the server Date header as a skew estimate', async () => {
    const { client } = makeClient([{ status: 200, body: {}, headers: { date: new Date(T0 + 45_000).toUTCString() } }]);
    await client.request(GET);
    expect(client.serverClock.skewMs()).toBe(45_000);
    expect(client.serverClock.samples()).toBe(1);
  });

  it('aborts on timeout and reports timedOut', async () => {
    const clock = createFakeClock();
    const tokens = createFakeTokenProvider();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = createHttpClient({
      baseUrl: 'https://tasks.example/tasks/v1',
      fetch,
      tokens,
      clock,
      random: createFakeRandom(0.5),
      logger: createSilentLogger(),
      maxAttempts: 1,
    });
    const p = client.request({ ...GET, timeoutMs: 1000 }).catch((e: unknown) => e);
    await clock.advance(1000);
    const err = await p;
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timedOut).toBe(true);
    expect(clock.pending()).toBe(0);
  });
});

describe('http-client status classification table', () => {
  const rows: Array<[string, Scripted, (e: unknown) => void]> = [
    [
      '400 → permanent ApiError',
      { status: 400, body: { error: { code: 400, message: 'bad' } } },
      (e) => {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(400);
        expect((e as ApiError).retryable).toBe(false);
      },
    ],
    [
      '403 rateLimitExceeded → RateLimitError, NOT an auth error',
      { status: 403, body: googleError('rateLimitExceeded'), headers: { 'retry-after': '12' } },
      (e) => {
        expect(e).toBeInstanceOf(RateLimitError);
        expect((e as RateLimitError).daily).toBe(false);
        expect((e as RateLimitError).retryAfterMs).toBe(12_000);
      },
    ],
    [
      '403 userRateLimitExceeded → RateLimitError',
      { status: 403, body: googleError('userRateLimitExceeded') },
      (e) => expect(e).toBeInstanceOf(RateLimitError),
    ],
    [
      '403 dailyLimitExceeded → RateLimitError(daily)',
      { status: 403, body: googleError('dailyLimitExceeded') },
      (e) => {
        expect(e).toBeInstanceOf(RateLimitError);
        expect((e as RateLimitError).daily).toBe(true);
      },
    ],
    [
      '403 insufficientPermissions → AuthError(insufficient_scope)',
      { status: 403, body: googleError('insufficientPermissions') },
      (e) => {
        expect(e).toBeInstanceOf(AuthError);
        expect((e as AuthError).reason).toBe('insufficient_scope');
      },
    ],
    [
      '404 → permanent ApiError',
      { status: 404, body: { error: { code: 404 } } },
      (e) => {
        expect((e as ApiError).status).toBe(404);
        expect((e as ApiError).retryable).toBe(false);
      },
    ],
    [
      '412 → ConflictError carrying the current etag',
      { status: 412, headers: { etag: '"srv"' } },
      (e) => {
        expect(e).toBeInstanceOf(ConflictError);
        expect((e as ConflictError).currentEtag).toBe('"srv"');
      },
    ],
    [
      '429 → RateLimitError',
      { status: 429, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, headers: { 'retry-after': '5' } },
      (e) => {
        expect(e).toBeInstanceOf(RateLimitError);
        expect((e as RateLimitError).retryAfterMs).toBe(5_000);
      },
    ],
    [
      '408 → retryable ApiError',
      { status: 408 },
      (e) => expect((e as ApiError).retryable).toBe(true),
    ],
    [
      '500 → retryable ApiError',
      { status: 500 },
      (e) => expect((e as ApiError).retryable).toBe(true),
    ],
    [
      '503 → retryable ApiError',
      { status: 503 },
      (e) => expect((e as ApiError).retryable).toBe(true),
    ],
  ];

  for (const [name, response, assert] of rows) {
    it(name, async () => {
      // maxAttempts 1 so we observe the classification, not the retry.
      const { client } = makeClient([response], { idempotentMax: 1 });
      const err = await client.request(GET).catch((e: unknown) => e);
      assert(err);
    });
  }

  it('a transport failure becomes NetworkError(timedOut=false)', async () => {
    const { client } = makeClient([{ status: 0, throws: new Error('ECONNREFUSED') }], { idempotentMax: 1 });
    const err = await client.request(GET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timedOut).toBe(false);
  });
});

describe('http-client 401 handling', () => {
  it('refreshes once and retries once', async () => {
    const { client, tokens, rec } = makeClient([{ status: 401, body: { error: { code: 401 } } }, { status: 200, body: { ok: true } }]);
    const r = await client.request(GET);
    expect(r.status).toBe(200);
    expect(tokens.calls.refresh).toBe(1);
    expect(rec.calls[1]!.init.headers['authorization']).toBe('Bearer ya29.test-token-r1');
    expect(tokens.calls.invalidGrant).toBe(0);
  });

  it('a second 401 is AuthError(unauthorized) and does NOT wipe the grant', async () => {
    const { client, tokens } = makeClient([{ status: 401 }, { status: 401 }]);
    const err = await client.request(GET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).reason).toBe('unauthorized');
    expect(tokens.calls.refresh).toBe(1);
    expect(tokens.calls.invalidGrant).toBe(0);
  });

  it('only a refresh that fails with invalid_grant reports the dead grant', async () => {
    const { client, tokens } = makeClient([{ status: 401 }]);
    tokens.failNextRefresh(new AuthError('invalid_grant'));
    const err = await client.request(GET).catch((e: unknown) => e);
    expect(tokens.calls.invalidGrant).toBe(1);
    expect((err as AuthError).reason).toBe('unauthorized');
  });
});

describe('http-client retry policy', () => {
  it('retries an idempotent request up to maxAttempts with jittered backoff', async () => {
    const { client, clock, rec } = makeClient([{ status: 500 }, { status: 500 }, { status: 200, body: { ok: 1 } }]);
    const p = client.request(GET);
    await clock.advance(10_000);
    await expect(p).resolves.toMatchObject({ status: 200 });
    expect(rec.calls).toHaveLength(3);
  });

  it('gives up after maxAttempts and rethrows', async () => {
    const { client, clock, rec } = makeClient([{ status: 500 }], { idempotentMax: 3 });
    const p = client.request(GET).catch((e: unknown) => e);
    await clock.advance(600_000);
    expect(await p).toBeInstanceOf(ApiError);
    expect(rec.calls).toHaveLength(3);
  });

  it('NEVER retries a non-idempotent request — a lost insert may have succeeded', async () => {
    const { client, clock, rec } = makeClient([{ status: 500 }, { status: 200, body: {} }]);
    const p = client.request(POST).catch((e: unknown) => e);
    await clock.advance(600_000);
    expect(await p).toBeInstanceOf(ApiError);
    expect(rec.calls).toHaveLength(1);
  });

  it('honours Retry-After for the wait between attempts', async () => {
    const { client, clock, rec } = makeClient([{ status: 429, headers: { 'retry-after': '60' } }, { status: 200, body: {} }]);
    const p = client.request(GET);
    await clock.advance(59_000);
    expect(rec.calls).toHaveLength(1);
    await clock.advance(2_000);
    await expect(p).resolves.toMatchObject({ status: 200 });
  });

  it('does not retry a daily quota exhaustion', async () => {
    const { client, clock, rec } = makeClient([{ status: 403, body: googleError('dailyLimitExceeded') }]);
    const p = client.request(GET).catch((e: unknown) => e);
    await clock.advance(600_000);
    expect(await p).toBeInstanceOf(RateLimitError);
    expect(rec.calls).toHaveLength(1);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(' 30 ', now)).toBe(30_000);
  });

  it('parses an HTTP-date — the form that silently becomes NaN if you forget it', () => {
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
  });

  it('clamps to five minutes and never goes negative', () => {
    expect(parseRetryAfter('99999', now)).toBe(300_000);
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });
});
