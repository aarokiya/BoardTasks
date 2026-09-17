import type { Logger } from '../logger';
import type { Clock, TimerHandle } from '../sync/clock';
import { RateLimitError } from './errors';

/**
 * Admission control in front of the HTTP client.
 *
 * Three jobs, each load-bearing:
 *  1. **Concurrency cap** — four in flight; more just queues at Google.
 *  2. **Token bucket with AIMD** — Google's real per-user rate limit is
 *     undocumented, so we converge on it: halve on a 429, recover 10% every
 *     30s. Fixed guesses are either too slow forever or 429 forever.
 *  3. **serialKey** — all mutations for one list share a key and run one at a
 *     time. This is required, not an optimisation: two concurrent `move`s in
 *     one list can land in either order and produce an ordering the user never
 *     asked for.
 *
 * Plus a daily-quota circuit breaker: once Google says `dailyLimitExceeded`
 * there is nothing to converge on, so we stop asking until the quota resets.
 */

export const MAX_CONCURRENCY = 4;
export const BUCKET_CAPACITY = 10;
export const BASE_REFILL_PER_SEC = 5;
export const MIN_REFILL_PER_SEC = 0.5;
export const RECOVERY_INTERVAL_MS = 30_000;
export const RECOVERY_FACTOR = 1.1;

/** 0 = user-visible (a push the user is waiting on), 2 = background (polling pulls). */
export type Priority = 0 | 2;

export interface SubmitOptions<T> {
  priority: Priority;
  /** Requests sharing a key never overlap. Use the list id for mutations. */
  serialKey?: string;
  label?: string;
  run: () => Promise<T>;
}

export interface QueueStats {
  inflight: number;
  queued: number;
  tokens: number;
  refillPerSec: number;
  circuitOpenUntil: number | null;
}

export interface RequestQueue {
  submit<T>(opts: SubmitOptions<T>): Promise<T>;
  /** Report an outcome so AIMD can react. `null` = success. */
  noteOutcome(error: unknown): void;
  stats(): QueueStats;
  /** Reject everything queued (used on sign-out / shutdown). */
  drainAndStop(): void;
  isCircuitOpen(): boolean;
}

interface Entry {
  seq: number;
  priority: Priority;
  serialKey: string | null;
  label: string;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class QueueStoppedError extends Error {
  readonly retryable = true;
  constructor() {
    super('Request queue stopped');
    this.name = 'QueueStoppedError';
  }
}

export interface RequestQueueOptions {
  clock: Clock;
  logger: Logger;
  maxConcurrency?: number;
  capacity?: number;
  refillPerSec?: number;
}

export function createRequestQueue(opts: RequestQueueOptions): RequestQueue {
  const { clock, logger } = opts;
  const maxConcurrency = opts.maxConcurrency ?? MAX_CONCURRENCY;
  const capacity = opts.capacity ?? BUCKET_CAPACITY;
  const baseRefill = opts.refillPerSec ?? BASE_REFILL_PER_SEC;

  const queue: Entry[] = [];
  const active = new Set<string>();
  let inflight = 0;
  let seq = 0;
  let stopped = false;

  let tokens = capacity;
  let refillPerSec = baseRefill;
  let lastRefillAt = clock.now();
  let lastRecoveryAt = clock.now();
  let wakeTimer: TimerHandle | null = null;

  let circuitOpenUntil: number | null = null;
  let circuitError: RateLimitError | null = null;

  function refill(): void {
    const now = clock.now();
    const elapsed = now - lastRefillAt;
    if (elapsed > 0) {
      tokens = Math.min(capacity, tokens + (elapsed / 1000) * refillPerSec);
      lastRefillAt = now;
    }
    // Additive-increase: creep back towards the base rate while nothing fails.
    while (refillPerSec < baseRefill && now - lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
      refillPerSec = Math.min(baseRefill, refillPerSec * RECOVERY_FACTOR);
      lastRecoveryAt += RECOVERY_INTERVAL_MS;
    }
    if (refillPerSec >= baseRefill) lastRecoveryAt = now;
  }

  function scheduleWake(ms: number): void {
    if (wakeTimer !== null) return;
    wakeTimer = clock.setTimeout(() => {
      wakeTimer = null;
      pump();
    }, Math.max(1, Math.ceil(ms)));
  }

  function checkCircuit(): void {
    if (circuitOpenUntil !== null && clock.now() >= circuitOpenUntil) {
      circuitOpenUntil = null;
      circuitError = null;
      refillPerSec = baseRefill;
      logger.info('daily-quota circuit closed; resuming requests');
    }
  }

  function pump(): void {
    if (stopped) return;
    checkCircuit();

    if (circuitOpenUntil !== null) {
      const err = circuitError ?? new RateLimitError(circuitOpenUntil - clock.now(), true, 'dailyLimitExceeded');
      for (const e of queue.splice(0)) {
        active.delete(e.serialKey ?? '');
        e.reject(err);
      }
      return;
    }

    refill();

    for (;;) {
      if (inflight >= maxConcurrency) return;
      const idx = queue.findIndex((e) => e.serialKey === null || !active.has(e.serialKey));
      if (idx < 0) return;
      if (tokens < 1) {
        scheduleWake(((1 - tokens) / refillPerSec) * 1000);
        return;
      }
      const entry = queue.splice(idx, 1)[0]!;
      tokens -= 1;
      inflight++;
      if (entry.serialKey !== null) active.add(entry.serialKey);
      // `run()` is invoked inside a promise chain, never called bare: a task
      // that throws SYNCHRONOUSLY would otherwise escape before `.finally` is
      // attached, leaking `inflight` and `active` until the queue deadlocks at
      // max concurrency with nothing actually running.
      void Promise.resolve()
        .then(() => entry.run())
        .then(entry.resolve, entry.reject)
        .finally(() => {
          inflight--;
          if (entry.serialKey !== null) active.delete(entry.serialKey);
          pump();
        });
    }
  }

  return {
    submit<T>(o: SubmitOptions<T>): Promise<T> {
      if (stopped) return Promise.reject(new QueueStoppedError());
      return new Promise<T>((resolve, reject) => {
        const entry: Entry = {
          seq: seq++,
          priority: o.priority,
          serialKey: o.serialKey ?? null,
          label: o.label ?? '',
          run: o.run,
          resolve: resolve as (v: unknown) => void,
          reject,
        };
        // Stable insert: priority first, then FIFO. FIFO within a serialKey is
        // what preserves outbox ordering for a list.
        let i = queue.length;
        while (i > 0 && queue[i - 1]!.priority > entry.priority) i--;
        queue.splice(i, 0, entry);
        pump();
      });
    },

    noteOutcome(error) {
      if (error === null) return;
      if (error instanceof RateLimitError) {
        if (error.daily) {
          circuitError = error;
          circuitOpenUntil = clock.now() + Math.max(error.retryAfterMs, 60_000);
          logger.warn(`daily quota exhausted; pausing all Google requests for ${Math.round((circuitOpenUntil - clock.now()) / 1000)}s`);
          pump();
          return;
        }
        // Multiplicative decrease. This is the whole point of AIMD: find the
        // undocumented real limit instead of guessing it.
        refillPerSec = Math.max(MIN_REFILL_PER_SEC, refillPerSec / 2);
        lastRecoveryAt = clock.now();
        tokens = 0;
        lastRefillAt = clock.now();
        logger.debug(`rate limited; refill now ${refillPerSec.toFixed(2)}/s`);
      }
    },

    stats() {
      refill();
      return {
        inflight,
        queued: queue.length,
        tokens: Math.floor(tokens),
        refillPerSec,
        circuitOpenUntil,
      };
    },

    isCircuitOpen() {
      checkCircuit();
      return circuitOpenUntil !== null;
    },

    drainAndStop() {
      stopped = true;
      clock.clearTimeout(wakeTimer);
      wakeTimer = null;
      for (const e of queue.splice(0)) e.reject(new QueueStoppedError());
    },
  };
}
