import { describe, expect, it } from 'vitest';
import { RateLimitError } from '../../../../src/main/api/errors';
import {
  BASE_REFILL_PER_SEC,
  createRequestQueue,
  QueueStoppedError,
  RECOVERY_INTERVAL_MS,
} from '../../../../src/main/api/request-queue';
import { createFakeClock } from '../../../fakes/fake-clock';
import { createSilentLogger } from '../../../fakes/fake-network';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeQueue(over: { capacity?: number; refillPerSec?: number; maxConcurrency?: number } = {}) {
  const clock = createFakeClock();
  const queue = createRequestQueue({
    clock,
    logger: createSilentLogger(),
    capacity: over.capacity ?? 1000,
    refillPerSec: over.refillPerSec ?? 1000,
    maxConcurrency: over.maxConcurrency,
  });
  return { clock, queue };
}

describe('request-queue concurrency', () => {
  it('runs at most four requests at once', async () => {
    const { clock, queue } = makeQueue();
    const gates = Array.from({ length: 8 }, () => deferred());
    let started = 0;
    let maxInflight = 0;
    let inflight = 0;

    const all = gates.map((g, i) =>
      queue.submit({
        priority: 0,
        run: async () => {
          started++;
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          await g.promise;
          inflight--;
          return i;
        },
      }),
    );

    await clock.flush();
    expect(started).toBe(4);
    expect(maxInflight).toBe(4);

    for (const g of gates) g.resolve();
    await Promise.all(all);
    expect(started).toBe(8);
    expect(maxInflight).toBe(4);
  });

  it('serialKey makes same-list mutations strictly sequential', async () => {
    // Required, not an optimisation: two concurrent moves in one list can land
    // in either order and produce an ordering the user never asked for.
    const { clock, queue } = makeQueue();
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const runs = gates.map((g, i) =>
      queue.submit({
        priority: 0,
        serialKey: 'list-A',
        run: async () => {
          order.push(`start${i}`);
          await g.promise;
          order.push(`end${i}`);
        },
      }),
    );

    await clock.flush();
    expect(order).toEqual(['start0']);
    gates[0]!.resolve();
    await clock.flush();
    expect(order).toEqual(['start0', 'end0', 'start1']);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(runs);
    expect(order).toEqual(['start0', 'end0', 'start1', 'end1', 'start2', 'end2']);
  });

  it('different serialKeys still run in parallel', async () => {
    const { clock, queue } = makeQueue();
    const gates = [deferred(), deferred()];
    const started: string[] = [];
    const runs = [
      queue.submit({ priority: 0, serialKey: 'A', run: async () => { started.push('A'); await gates[0]!.promise; } }),
      queue.submit({ priority: 0, serialKey: 'B', run: async () => { started.push('B'); await gates[1]!.promise; } }),
    ];
    await clock.flush();
    expect(started).toEqual(['A', 'B']);
    gates[0]!.resolve();
    gates[1]!.resolve();
    await Promise.all(runs);
  });

  it('user-visible work (priority 0) jumps ahead of background work (priority 2)', async () => {
    const { clock, queue } = makeQueue({ maxConcurrency: 1 });
    const blocker = deferred();
    const order: string[] = [];
    const first = queue.submit({ priority: 2, run: async () => { order.push('blocker'); await blocker.promise; } });
    await clock.flush();
    const bg = queue.submit({ priority: 2, run: () => { order.push('background'); return Promise.resolve(); } });
    const fg = queue.submit({ priority: 0, run: () => { order.push('foreground'); return Promise.resolve(); } });
    blocker.resolve();
    await Promise.all([first, bg, fg]);
    expect(order).toEqual(['blocker', 'foreground', 'background']);
  });

  it('a task that throws SYNCHRONOUSLY still releases its slot', async () => {
    // Otherwise `inflight` leaks and the queue deadlocks at max concurrency
    // with nothing actually running — a silent, permanent stall.
    const { queue } = makeQueue({ maxConcurrency: 2 });
    for (let i = 0; i < 6; i++) {
      await expect(
        queue.submit({
          priority: 0,
          serialKey: 'L1',
          run: () => {
            throw new Error('sync boom');
          },
        }),
      ).rejects.toThrow('sync boom');
    }
    expect(queue.stats().inflight).toBe(0);
    await expect(queue.submit({ priority: 0, serialKey: 'L1', run: () => Promise.resolve('still alive') })).resolves.toBe('still alive');
  });

  it('preserves FIFO within a priority', async () => {
    const { queue } = makeQueue({ maxConcurrency: 1 });
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) => queue.submit({ priority: 0, run: () => { order.push(i); return Promise.resolve(); } })),
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('request-queue token bucket', () => {
  it('spends a token per request and waits for a refill when the bucket empties', async () => {
    const { clock, queue } = makeQueue({ capacity: 2, refillPerSec: 1, maxConcurrency: 4 });
    const done: number[] = [];
    const runs = [0, 1, 2].map((i) => queue.submit({ priority: 0, run: () => { done.push(i); return Promise.resolve(); } }));

    await clock.flush();
    expect(done).toEqual([0, 1]); // capacity 2

    await clock.advance(999);
    expect(done).toEqual([0, 1]);

    await clock.advance(2);
    expect(done).toEqual([0, 1, 2]);
    await Promise.all(runs);
  });
});

describe('request-queue AIMD', () => {
  it('halves the refill rate on a 429 and recovers 10% every 30s', async () => {
    const { clock, queue } = makeQueue({ capacity: 10, refillPerSec: BASE_REFILL_PER_SEC });
    expect(queue.stats().refillPerSec).toBe(BASE_REFILL_PER_SEC);

    queue.noteOutcome(new RateLimitError(1000, false, 'rateLimitExceeded'));
    expect(queue.stats().refillPerSec).toBeCloseTo(BASE_REFILL_PER_SEC / 2, 5);

    queue.noteOutcome(new RateLimitError(1000, false, 'rateLimitExceeded'));
    expect(queue.stats().refillPerSec).toBeCloseTo(BASE_REFILL_PER_SEC / 4, 5);

    await clock.advance(RECOVERY_INTERVAL_MS);
    expect(queue.stats().refillPerSec).toBeCloseTo((BASE_REFILL_PER_SEC / 4) * 1.1, 5);

    // ...and eventually converges back on the base rate, never past it.
    await clock.advance(RECOVERY_INTERVAL_MS * 40);
    expect(queue.stats().refillPerSec).toBe(BASE_REFILL_PER_SEC);
  });

  it('a success does not change the rate', () => {
    const { queue } = makeQueue({ refillPerSec: BASE_REFILL_PER_SEC });
    queue.noteOutcome(null);
    queue.noteOutcome(new Error('unrelated'));
    expect(queue.stats().refillPerSec).toBe(BASE_REFILL_PER_SEC);
  });
});

describe('request-queue daily-quota circuit breaker', () => {
  it('rejects everything queued and everything new until the quota resets', async () => {
    const { clock, queue } = makeQueue();
    queue.noteOutcome(new RateLimitError(120_000, true, 'dailyLimitExceeded'));
    expect(queue.isCircuitOpen()).toBe(true);

    const err = await queue.submit({ priority: 0, run: () => Promise.resolve('never') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).daily).toBe(true);

    // The breaker holds for at least a minute even if Google suggested less.
    await clock.advance(60_000);
    expect(queue.isCircuitOpen()).toBe(true);

    await clock.advance(61_000);
    expect(queue.isCircuitOpen()).toBe(false);
    await expect(queue.submit({ priority: 0, run: () => Promise.resolve('ok') })).resolves.toBe('ok');
  });
});

describe('request-queue shutdown', () => {
  it('rejects queued and subsequent work with QueueStoppedError', async () => {
    const { clock, queue } = makeQueue({ maxConcurrency: 1 });
    const blocker = deferred();
    const running = queue.submit({ priority: 0, run: () => blocker.promise });
    await clock.flush();
    const queued = queue.submit({ priority: 0, run: () => Promise.resolve() }).catch((e: unknown) => e);

    queue.drainAndStop();
    expect(await queued).toBeInstanceOf(QueueStoppedError);
    await expect(queue.submit({ priority: 0, run: () => Promise.resolve() })).rejects.toBeInstanceOf(QueueStoppedError);

    blocker.resolve();
    await running;
  });
});
