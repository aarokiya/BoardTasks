import type { Random } from './clock';
import { ApiError, ConflictError, NetworkError, RateLimitError } from '../api/errors';
import { AuthError } from '../auth/types';

export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 300_000;
/** Attempts before an outbox entry stops retrying and waits for the user. */
export const PARK_AFTER = 8;
/** Blocked passes before we conclude the dependency will never resolve. */
export const BLOCKED_PASSES_BEFORE_PARK = 3;

/**
 * Exponential backoff with "full-ish" jitter: the delay is uniform in
 * [exp/2, exp). Jitter is not decoration — a laptop waking with 200 queued
 * entries would otherwise retry them all in lockstep and cause the very 429s
 * the backoff exists to avoid. Keeping the lower half means we still back off
 * meaningfully instead of occasionally retrying immediately.
 *
 * @param attempts number of attempts already made, 1-based for the first retry.
 */
export function nextDelay(attempts: number, random: Random): number {
  const n = Math.max(1, Math.floor(attempts));
  // 2 ** 30 * 1000 overflows past MAX long before Infinity; clamp the exponent too.
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(n - 1, 30));
  const half = exp / 2;
  return Math.floor(half + random.next() * half);
}

/**
 * What the outbox should do with a failure.
 * - transient: wait and retry (attempts++)
 * - rate_limited: wait exactly as long as the server said; not the entry's fault
 * - permanent: park now; retrying eight times proves nothing
 * - conflict: the server's copy moved; re-pull and retry
 * - auth: abort the whole drain, the engine pauses
 * - blocked: produced by the readiness check, never by an error
 */
export type Disposition = 'transient' | 'rate_limited' | 'permanent' | 'conflict' | 'auth' | 'blocked';

export interface Classification {
  disposition: Disposition;
  /** Machine code stored on the outbox row. */
  code: string;
  /** Human-readable, shown in the "Changes that didn't sync" sheet. */
  message: string;
  /** Present for rate_limited; the exact wait the server asked for. */
  retryAfterMs: number | null;
  /** True for a daily-quota exhaustion, which pauses everything. */
  daily: boolean;
}

export function classifyError(e: unknown): Classification {
  if (e instanceof AuthError) {
    return { disposition: 'auth', code: `auth_${e.reason}`, message: authMessage(e.reason), retryAfterMs: null, daily: false };
  }
  if (e instanceof RateLimitError) {
    return {
      disposition: 'rate_limited',
      code: e.daily ? 'daily_limit' : 'rate_limited',
      message: e.daily
        ? "Google's daily quota for this project is used up. Sync resumes when the quota resets."
        : 'Google is rate-limiting this account. Retrying shortly.',
      retryAfterMs: e.retryAfterMs,
      daily: e.daily,
    };
  }
  if (e instanceof ConflictError) {
    return { disposition: 'conflict', code: 'conflict', message: 'This item changed on Google while we were sending it.', retryAfterMs: null, daily: false };
  }
  if (e instanceof NetworkError) {
    return {
      disposition: 'transient',
      code: e.timedOut ? 'timeout' : 'network',
      message: e.timedOut ? 'The request to Google timed out.' : "Couldn't reach Google.",
      retryAfterMs: null,
      daily: false,
    };
  }
  if (e instanceof ApiError) {
    return {
      disposition: e.retryable ? 'transient' : 'permanent',
      code: `http_${e.status}`,
      message: apiMessage(e),
      retryAfterMs: null,
      daily: false,
    };
  }
  return { disposition: 'transient', code: 'unknown', message: messageOf(e), retryAfterMs: null, daily: false };
}

function authMessage(reason: AuthError['reason']): string {
  switch (reason) {
    case 'insufficient_scope':
      return 'BoardTasks is not allowed to edit your tasks. Sign in again and grant the Tasks permission.';
    case 'invalid_grant':
      return 'Google revoked this sign-in. Sign in again — your unsynced changes are kept.';
    default:
      return 'Your Google sign-in needs renewing.';
  }
}

function apiMessage(e: ApiError): string {
  const detail = e.googleMessage;
  switch (e.status) {
    case 400:
      return detail ? `Google rejected this change: ${detail}` : 'Google rejected this change as invalid.';
    case 403:
      return detail ? `Google refused this change: ${detail}` : 'Google refused this change.';
    case 404:
      return 'This item no longer exists on Google.';
    case 409:
      return 'Google reported a conflicting change.';
    default:
      return detail ? `Google returned ${e.status}: ${detail}` : `Google returned ${e.status}.`;
  }
}

export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Unknown error';
}
