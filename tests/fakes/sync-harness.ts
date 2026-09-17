import type { MainEvent } from '../../src/shared/events';
import { createRequestQueue, type RequestQueue } from '../../src/main/api/request-queue';
import type { Logger } from '../../src/main/logger';
import { isoAt } from '../../src/main/sync/clock';
import { createSyncEngine, type SyncEngine } from '../../src/main/sync/engine';
import { runPrePull, runPull, type PullDeps, type PullOptions, type PullResult } from '../../src/main/sync/pull';
import { runPush, type PushDeps, type PushResult } from '../../src/main/sync/push';
import { createFakeClock, createFakeRandom, type FakeClock } from './fake-clock';
import { createFakeGoogle, type FakeGoogle, type FakeGoogleOptions } from './fake-google-api';
import { createFakeNetwork, createSilentLogger, type FakeNetworkMonitor } from './fake-network';
import { createFakeTokenProvider, type FakeTokenProvider } from './fake-token-provider';

/**
 * Everything the sync engine needs, with every source of nondeterminism
 * replaced by something the test drives. The store is the REAL repositories
 * over an in-memory sqlite database — mocking the data layer would only prove
 * the mock works.
 */
export interface SyncHarness {
  clock: FakeClock;
  google: FakeGoogle;
  network: FakeNetworkMonitor;
  tokens: FakeTokenProvider;
  logger: Logger & { lines: string[] };
  queue: RequestQueue;
  pushDeps: PushDeps;
  pullDeps: PullDeps;
  events: MainEvent[];
  /** Every outcome reported to the network monitor; `null` = success. */
  observed: unknown[];
  push(): Promise<PushResult>;
  pull(opts?: PullOptions): Promise<PullResult>;
  cycle(opts?: PullOptions): Promise<{ push: PushResult; pull: PullResult }>;
  engine(): SyncEngine;
  now(): string;
  /**
   * Await a promise while running the fake clock, so timers the work arms
   * mid-flight (a token-bucket refill after a 429, an in-wrapper retry
   * backoff) actually fire instead of stranding it.
   */
  settle<T>(p: Promise<T>): Promise<T>;
}

export const WALL_CLOCK_LEAD_MS = 60_000;

export interface HarnessOptions {
  google?: FakeGoogleOptions;
  random?: number | readonly number[];
  /** Fake-clock origin. Defaults to real wall time — see below. */
  start?: number;
}

export function createSyncHarness(opts: HarnessOptions = {}): SyncHarness {
  // The repositories stamp rows with the REAL wall clock (`nowIso()`) — they
  // predate this track and take no injected clock — while the outbox drain
  // compares `next_attempt_at` against the injected one. Starting the fake
  // clock a minute ahead of wall time keeps every freshly enqueued entry
  // eligible without any sleeping. Assertions here are always about elapsed
  // deltas measured on the fake clock, never about absolute instants.
  const clock = createFakeClock(opts.start ?? Date.now() + WALL_CLOCK_LEAD_MS);
  const random = createFakeRandom(opts.random ?? 0.5);
  const google = createFakeGoogle({ now: () => clock.now(), ...opts.google });
  const network = createFakeNetwork('online');
  const tokens = createFakeTokenProvider();
  const logger = createSilentLogger();
  const queue = createRequestQueue({ clock, logger, refillPerSec: 1_000_000, capacity: 1_000_000 });
  const events: MainEvent[] = [];
  const observed: unknown[] = [];

  const observe = (e: unknown): void => {
    observed.push(e);
    queue.noteOutcome(e);
    if (e === null) network.noteSuccess();
    else network.noteFailure(e);
  };

  const pushDeps: PushDeps = { api: google, clock, random, logger, queue, observe };
  const pullDeps: PullDeps = { api: google, clock, logger, queue, priority: 0, observe };

  return {
    clock,
    google,
    network,
    tokens,
    logger,
    queue,
    pushDeps,
    pullDeps,
    events,
    observed,
    now: () => isoAt(clock.now()),
    async settle(p) {
      let done = false;
      // Capture the outcome as a VALUE: a promise that rejects while we are
      // still spinning the clock would be reported as an unhandled rejection
      // before anyone gets the chance to await it.
      const tracked = p.then(
        (value) => {
          done = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          done = true;
          return { ok: false as const, error };
        },
      );
      for (let i = 0; i < 400 && !done; i++) await clock.advance(1_000);
      const outcome = await tracked;
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    },
    push: () => runPush(pushDeps),
    pull: (o) => runPull(pullDeps, isoAt(clock.now()), o ?? {}),
    async cycle(o) {
      // Mirrors the engine exactly, pre-push conflict check included.
      const pre = await runPrePull(pullDeps, isoAt(clock.now()));
      const push = await runPush({ ...pushDeps, unverifiedLists: pre.unverified });
      const pull = await runPull(pullDeps, isoAt(clock.now()), o ?? {});
      return { push, pull };
    },
    engine: () =>
      createSyncEngine({
        api: google,
        tokens,
        clock,
        random,
        network,
        queue,
        logger,
        emit: (e) => events.push(e),
      }),
  };
}
