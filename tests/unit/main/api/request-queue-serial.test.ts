import { describe, expect, it } from 'vitest';

import { RateLimitError } from '../../../../src/main/api/errors';
import { createRequestQueue } from '../../../../src/main/api/request-queue';
import { createFakeClock } from '../../../fakes/fake-clock';
import { createSilentLogger } from '../../../fakes/fake-network';

/**
 * `serialKey` is the only thing keeping two mutations for one list from landing
 * in either order. Anything that releases the key while its holder is still
 * running is an ordering bug, not a tidiness one.
 */

function queue(): { q: ReturnType<typeof createRequestQueue>; clock: ReturnType<typeof createFakeClock> } {
  const clock = createFakeClock();
  return { q: createRequestQueue({ clock, logger: createSilentLogger(), refillPerSec: 1_000_000, capacity: 1_000_000 }), clock };
}

describe('serialKey under pressure', () => {
  it('never releases a running request’s key when the daily-quota circuit trips', async () => {
    const { q, clock } = queue();
    let concurrent = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const run = async (): Promise<void> => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate;
      concurrent--;
    };

    const first = q.submit({ priority: 0, serialKey: 'L1', run });
    await clock.flush();
    expect(concurrent).toBe(1);

    // Two more for the same list are queued behind it.
    const second = q.submit({ priority: 0, serialKey: 'L1', run }).catch(() => 'rejected');
    const third = q.submit({ priority: 0, serialKey: 'L1', run }).catch(() => 'rejected');

    // Google reports the daily quota exhausted: everything QUEUED is rejected,
    // but the in-flight request keeps its slot and its serial key.
    q.noteOutcome(new RateLimitError(60_000, true, 'dailyLimitExceeded'));
    await clock.flush();
    expect(await second).toBe('rejected');
    expect(await third).toBe('rejected');

    release();
    await first;
    await clock.flush();
    expect(maxConcurrent).toBe(1);
  });

  it('keeps FIFO for one serial key when a request is retried after a 429', async () => {
    const { q, clock } = queue();
    const order: string[] = [];
    const task = (label: string) => async (): Promise<void> => {
      order.push(label);
      await Promise.resolve();
    };

    // The outbox drains sequentially, so a retried entry is re-submitted before
    // anything newer for the same list is offered to the queue.
    await q.submit({ priority: 0, serialKey: 'L1', run: task('create#1') });

    // A 429 empties the token bucket: the retry has to wait for a refill, and
    // newer work for the same list must not slip past while it does.
    q.noteOutcome(new RateLimitError(1_000, false, 'rateLimitExceeded'));
    const retry = q.submit({ priority: 0, serialKey: 'L1', run: task('create#1-retry') });
    const newer = q.submit({ priority: 0, serialKey: 'L1', run: task('move#2') });
    await clock.flush();
    expect(order).toEqual(['create#1']); // both are still waiting on tokens

    await clock.advance(5_000);
    await Promise.all([retry, newer]);

    expect(order).toEqual(['create#1', 'create#1-retry', 'move#2']);
  });

  it('a background pull never overtakes a queued mutation for the same list', async () => {
    const { q, clock } = queue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const blocking = q.submit({
      priority: 0,
      serialKey: 'L1',
      run: async () => {
        order.push('mutation-a');
        await gate;
      },
    });
    await clock.flush();

    const b = q.submit({ priority: 0, serialKey: 'L1', run: () => { order.push('mutation-b'); return Promise.resolve(); } });
    const pull = q.submit({ priority: 2, serialKey: 'L1', run: () => { order.push('pull'); return Promise.resolve(); } });

    release();
    await Promise.all([blocking, b, pull]);
    await clock.flush();
    expect(order).toEqual(['mutation-a', 'mutation-b', 'pull']);
  });
});
