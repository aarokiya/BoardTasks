import type { MainEvent } from '../../src/shared/events';
import { createRequestQueue, type RequestQueue } from '../../src/main/api/request-queue';
import type { Logger } from '../../src/main/logger';
import { isoAt } from '../../src/main/sync/clock';
import { createSyncEngine, type SyncEngine } from '../../src/main/sync/engine';
import { runPull, type PullDeps, type PullOptions, type PullResult } from '../../src/main/sync/pull';
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
  observed: Array<unknown | null>;
  push(): Promise<PushResult>;
  pull(opts?: PullOptions): Promise<PullResult>;
  cycle(opts?: PullOptions): Promise<{ push: PushResult; pull: PullResult }>;
  engine(): SyncEngine;
  now(): string;
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
  const observed: Array<unknown | null> = [];

  const observe = (e: unknown | null): void => {
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
    push: () => runPush(pushDeps),
    pull: (o) => runPull(pullDeps, isoAt(clock.now()), o ?? {}),
    async cycle(o) {
      const push = await runPush(pushDeps);
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
