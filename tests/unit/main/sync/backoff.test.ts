import { describe, expect, it } from 'vitest';
import { ApiError, ConflictError, NetworkError, RateLimitError } from '../../../../src/main/api/errors';
import { AuthError } from '../../../../src/main/auth/types';
import {
  BASE_DELAY_MS,
  classifyError,
  MAX_DELAY_MS,
  nextDelay,
  PARK_AFTER,
} from '../../../../src/main/sync/backoff';
import { createFakeRandom } from '../../../fakes/fake-clock';

describe('nextDelay', () => {
  it('is exact for a known random sequence', () => {
    // exp = 1s, 2s, 4s, 8s...; delay is uniform in [exp/2, exp).
    const r = createFakeRandom([0, 0.5, 0.999999, 0]);
    expect(nextDelay(1, r)).toBe(500); // 500 + 0 * 500
    expect(nextDelay(2, r)).toBe(1500); // 1000 + 0.5 * 1000
    expect(nextDelay(3, r)).toBe(3999); // 2000 + ~1.0 * 2000, floored
    expect(nextDelay(4, r)).toBe(4000); // 4000 + 0 * 4000
  });

  it('never returns the full exponential and never less than half of it', () => {
    for (let attempts = 1; attempts <= 12; attempts++) {
      const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
      for (const v of [0, 0.25, 0.5, 0.75, 0.9999]) {
        const d = nextDelay(attempts, createFakeRandom(v));
        expect(d).toBeGreaterThanOrEqual(exp / 2);
        expect(d).toBeLessThan(exp);
      }
    }
  });

  it('two entries with different randomness do not retry in lockstep', () => {
    // Jitter is not decoration: 200 queued entries retrying together cause the
    // very 429s the backoff exists to avoid.
    const a = nextDelay(5, createFakeRandom(0.1));
    const b = nextDelay(5, createFakeRandom(0.9));
    expect(a).not.toBe(b);
  });

  it('clamps at five minutes and tolerates absurd attempt counts', () => {
    expect(nextDelay(50, createFakeRandom(0.999999))).toBeLessThan(MAX_DELAY_MS);
    expect(nextDelay(50, createFakeRandom(0))).toBe(MAX_DELAY_MS / 2);
    expect(Number.isFinite(nextDelay(1000, createFakeRandom(0.5)))).toBe(true);
  });

  it('treats 0 and negative attempts as the first retry', () => {
    expect(nextDelay(0, createFakeRandom(0))).toBe(500);
    expect(nextDelay(-3, createFakeRandom(0))).toBe(500);
  });

  it('parks after 8 attempts', () => {
    expect(PARK_AFTER).toBe(8);
  });
});

describe('classifyError', () => {
  it('auth errors abort the drain and never park the entry', () => {
    const c = classifyError(new AuthError('invalid_grant'));
    expect(c.disposition).toBe('auth');
    expect(c.code).toBe('auth_invalid_grant');
    expect(c.message).toMatch(/unsynced changes are kept/i);
  });

  it('insufficient_scope explains what the user has to do', () => {
    expect(classifyError(new AuthError('insufficient_scope')).message).toMatch(/grant the Tasks permission/i);
  });

  it('a burst rate limit is transient with an exact wait', () => {
    const c = classifyError(new RateLimitError(4_000, false, 'rateLimitExceeded'));
    expect(c.disposition).toBe('rate_limited');
    expect(c.retryAfterMs).toBe(4_000);
    expect(c.daily).toBe(false);
  });

  it('a daily quota is flagged separately so the engine can stop asking', () => {
    const c = classifyError(new RateLimitError(600_000, true, 'dailyLimitExceeded'));
    expect(c.daily).toBe(true);
    expect(c.code).toBe('daily_limit');
  });

  it('412 is a conflict, not a failure', () => {
    expect(classifyError(new ConflictError('"e"')).disposition).toBe('conflict');
  });

  it('network failures are transient and distinguish a timeout', () => {
    expect(classifyError(new NetworkError(new Error('x'), false)).code).toBe('network');
    expect(classifyError(new NetworkError(new Error('x'), true)).code).toBe('timeout');
    expect(classifyError(new NetworkError(new Error('x'), true)).disposition).toBe('transient');
  });

  it('400 and a real 403 park immediately — retrying eight times proves nothing', () => {
    expect(classifyError(new ApiError(400, { message: 'Invalid title' }, false)).disposition).toBe('permanent');
    expect(classifyError(new ApiError(400, { message: 'Invalid title' }, false)).message).toMatch(/Invalid title/);
    expect(classifyError(new ApiError(403, null, false)).disposition).toBe('permanent');
    expect(classifyError(new ApiError(404, null, false)).message).toMatch(/no longer exists on Google/);
  });

  it('5xx is transient', () => {
    expect(classifyError(new ApiError(503, null, true)).disposition).toBe('transient');
  });

  it('an unrecognised throw is transient, not silently dropped', () => {
    const c = classifyError(new Error('who knows'));
    expect(c.disposition).toBe('transient');
    expect(c.message).toBe('who knows');
    expect(classifyError('a string').message).toBe('a string');
  });
});
