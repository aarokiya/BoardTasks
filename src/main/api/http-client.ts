import type { Logger } from '../logger';
import type { Clock, Random } from '../sync/clock';
import type { TokenProvider } from '../auth/types';
import { AuthError } from '../auth/types';
import { nextDelay } from '../sync/backoff';
import { ApiError, classifyForbidden, ConflictError, NetworkError, parseGoogleError, RateLimitError } from './errors';
import { createServerClock, type ServerClock } from './server-clock';

/** The slice of `fetch` we use. `net.fetch` and global `fetch` both satisfy it. */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual' | 'error';
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path relative to baseUrl, already URL-encoded. Must start with '/'. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * Whether the wrapper may retry this request by itself.
   *
   * `tasks.insert` is NOT idempotent: a lost 500 response might mean the task
   * WAS created, and auto-retrying silently duplicates it. Its retry is owned
   * by the outbox, which reconciles duplicates on the next pull.
   */
  idempotent: boolean;
  timeoutMs?: number;
  /** Extra headers, e.g. If-Match. */
  headers?: Record<string, string>;
  /** Label for logs. */
  label?: string;
}

export interface HttpResult<T> {
  data: T;
  status: number;
  etag: string | null;
  /** The server's `Date` header, verbatim. The only trustworthy "now". */
  serverDate: string | null;
}

export interface HttpClient {
  request<T = unknown>(spec: RequestSpec): Promise<HttpResult<T>>;
  readonly serverClock: ServerClock;
  readonly baseUrl: string;
}

export interface HttpClientOptions {
  baseUrl: string;
  fetch: FetchLike;
  tokens: TokenProvider;
  clock: Clock;
  random: Random;
  logger: Logger;
  /** Default per-request timeout. */
  timeoutMs?: number;
  /** Max attempts for an idempotent request (including the first). */
  maxAttempts?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Retry-After is clamped: Google occasionally suggests absurd waits. */
export const MAX_RETRY_AFTER_MS = 300_000;
/**
 * A daily quota does not clear in five minutes. Google resets it at midnight
 * Pacific and does not say when in the response, so an hour is the floor we
 * wait before asking again.
 */
export const DAILY_RETRY_AFTER_MS = 3_600_000;
/**
 * The longest delay the wrapper will absorb itself.
 *
 * Anything longer belongs to the outbox and to the user interface, not to a
 * sleeping promise: a `sleep(60_000)` inside the request holds the whole sync
 * cycle open, so the status pill says "Syncing…" for a minute and the
 * countdown the user needs is never computed. Throw instead, and let the
 * engine park the cycle and show the wait.
 */
export const MAX_INLINE_RETRY_MS = 2_000;

/**
 * Retry-After comes in two spellings — delta-seconds ("120") and an HTTP-date
 * ("Wed, 21 Oct 2026 07:28:00 GMT"). Handling only the first is the classic
 * bug: the HTTP-date form parses as NaN and the client hammers the server.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number, maxMs = MAX_RETRY_AFTER_MS): number | null {
  if (value === null || value === undefined) return null;
  const s = value.trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return clampRetry(Number(s) * 1000, maxMs);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return clampRetry(t - nowMs, maxMs);
}

function clampRetry(ms: number, maxMs = MAX_RETRY_AFTER_MS): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(maxMs, Math.max(0, Math.round(ms)));
}

function buildUrl(baseUrl: string, path: string, query: Record<string, QueryValue> | undefined): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const qs: string[] = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return `${base}${path}${qs.length > 0 ? `?${qs.join('&')}` : ''}`;
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const { baseUrl, fetch: doFetch, tokens, clock, random, logger } = opts;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const serverClock = createServerClock(clock);

  async function sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      clock.setTimeout(resolve, ms);
    });
  }

  /** One wire round trip. Never retries; classification only. */
  async function once(spec: RequestSpec, token: string): Promise<{ result: HttpResult<unknown>; status: number }> {
    const url = buildUrl(baseUrl, spec.path, spec.query);
    const controller = new AbortController();
    let timedOut = false;
    const timer = clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, spec.timeoutMs ?? defaultTimeout);

    let res: FetchResponseLike;
    try {
      res = await doFetch(url, {
        method: spec.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...spec.headers,
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new NetworkError(e, timedOut);
    } finally {
      // ALWAYS clear: a leaked 30s timer keeps the event loop (and the app) alive.
      clock.clearTimeout(timer);
    }

    const serverDate = res.headers.get('date');
    serverClock.observe(serverDate);
    const etag = res.headers.get('etag');
    const status = res.status;
    const text = await res.text().catch(() => '');

    if (status >= 200 && status < 300) {
      const data: unknown = text.length === 0 ? undefined : safeJson(text);
      return { result: { data, status, etag, serverDate }, status };
    }

    const body = parseGoogleError(text);

    if (status === 401) throw new UnauthorizedSignal(body);

    if (status === 403) {
      const { kind, reason } = classifyForbidden(body);
      if (kind === 'rate' || kind === 'daily') {
        const cap = kind === 'daily' ? DAILY_RETRY_AFTER_MS : MAX_RETRY_AFTER_MS;
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'), clock.now(), cap);
        throw new RateLimitError(retryAfter ?? (kind === 'daily' ? DAILY_RETRY_AFTER_MS : 30_000), kind === 'daily', reason, 403, body);
      }
      throw new AuthError('insufficient_scope', body?.message ?? 'Google refused the request (insufficient permissions).');
    }

    if (status === 412) throw new ConflictError(etag, body);

    if (status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), clock.now());
      const reason = body?.errors?.[0]?.reason ?? 'rateLimitExceeded';
      throw new RateLimitError(retryAfter ?? 30_000, false, reason, 429, body);
    }

    const retryable = status === 408 || (status >= 500 && status < 600);
    throw new ApiError(status, body, retryable);
  }

  async function attempt(spec: RequestSpec): Promise<HttpResult<unknown>> {
    let refreshed = false;
    for (;;) {
      const token = refreshed ? await tokens.forceRefresh() : await tokens.getAccessToken();
      try {
        const { result } = await once(spec, token);
        return result;
      } catch (e) {
        if (!(e instanceof UnauthorizedSignal)) throw e;
        if (refreshed) {
          // Second 401 with a token we just minted: the grant is fine, the
          // request isn't. Do NOT wipe credentials over this.
          throw new AuthError('unauthorized', 'Google rejected the access token.');
        }
        refreshed = true;
      }
    }
  }

  /**
   * Wraps `attempt` so that a forceRefresh that itself dies with invalid_grant
   * reports the dead grant exactly once, and never on a plain 401-after-refresh.
   */
  async function attemptWithRefresh(spec: RequestSpec): Promise<HttpResult<unknown>> {
    try {
      return await attempt(spec);
    } catch (e) {
      if (e instanceof AuthError && e.reason === 'invalid_grant') {
        tokens.handleInvalidGrant();
        throw new AuthError('unauthorized', 'Google revoked this sign-in.');
      }
      throw e;
    }
  }

  return {
    baseUrl,
    serverClock,
    async request<T>(spec: RequestSpec): Promise<HttpResult<T>> {
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          const r = await attemptWithRefresh(spec);
          return r as HttpResult<T>;
        } catch (e) {
          const retryable = isRetryable(e);
          if (!spec.idempotent || !retryable || attempts >= maxAttempts) throw e;
          const wait = e instanceof RateLimitError ? e.retryAfterMs : nextDelay(attempts, random);
          // Absorb only a blink. A longer wait is the caller's business: the
          // engine can then show 'rate_limited' with a countdown and re-arm
          // the cycle for exactly that moment, instead of the UI sitting on
          // "Syncing…" while this promise sleeps.
          if (wait > MAX_INLINE_RETRY_MS) {
            logger.debug(`${spec.label ?? spec.path} needs ${wait}ms; handing the wait to the caller`);
            throw e;
          }
          logger.debug(`${spec.label ?? spec.path} attempt ${attempts} failed (${describe(e)}); retrying in ${wait}ms`);
          await sleep(wait);
        }
      }
    },
  };
}

/** Internal marker so the 401 path is handled in one place. */
class UnauthorizedSignal extends Error {
  constructor(readonly body: ReturnType<typeof parseGoogleError>) {
    super('401');
    this.name = 'UnauthorizedSignal';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRetryable(e: unknown): boolean {
  if (e instanceof RateLimitError) return !e.daily;
  if (e instanceof NetworkError) return true;
  if (e instanceof ConflictError) return false;
  if (e instanceof ApiError) return e.retryable;
  return false;
}

function describe(e: unknown): string {
  if (e instanceof ApiError) return `${e.name} ${e.status}`;
  if (e instanceof Error) return e.name;
  return 'error';
}
