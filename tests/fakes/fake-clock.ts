import type { Clock, Random, TimerHandle } from '../../src/main/sync/clock';

/**
 * A clock whose timers fire in order when you ask them to, so a 24-hour
 * backoff scenario runs in a millisecond. `advance` flushes microtasks between
 * every timer so promise chains started by a timer complete before the next
 * one fires — without that, "advance past the retry delay" would return before
 * the retry had actually run.
 */
export interface FakeClock extends Clock {
  advance(ms: number): Promise<void>;
  /** Fire every pending timer regardless of when it was due. */
  runAll(maxRounds?: number): Promise<void>;
  /** Let queued promise callbacks run without moving time. */
  flush(): Promise<void>;
  pending(): number;
  set(epochMs: number): void;
}

interface Entry {
  id: number;
  at: number;
  fn: () => void;
}

export const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);
/** Safety net so a self-rescheduling timer can never hang the suite. */
const MAX_ROUNDS = 5_000;

export async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function createFakeClock(start: number = T0): FakeClock {
  let now = start;
  let seq = 1;
  let timers: Entry[] = [];

  function due(limit: number): Entry | null {
    let best: Entry | null = null;
    for (const t of timers) {
      if (t.at > limit) continue;
      if (best === null || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    return best;
  }

  return {
    now: () => now,
    nowIso: () => new Date(now).toISOString(),
    setTimeout(fn, ms) {
      const entry: Entry = { id: seq++, at: now + Math.max(0, ms), fn };
      timers.push(entry);
      return entry.id as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      if (handle === null) return;
      const id = handle as unknown as number;
      timers = timers.filter((t) => t.id !== id);
    },
    /**
     * Flush FIRST, then fire. An awaited promise chain (a fetch, a token
     * refresh) only arms its timer once its microtasks have run, so checking
     * for due timers before flushing would miss the very timer the test is
     * waiting for — and jumping `now` straight to the target would arm it
     * beyond the window. Alternate the two until quiescent.
     */
    async advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < MAX_ROUNDS; guard++) {
        await flushMicrotasks();
        const next = due(target);
        if (!next) break;
        timers = timers.filter((t) => t.id !== next.id);
        now = Math.max(now, next.at);
        next.fn();
      }
      now = target;
      await flushMicrotasks();
    },
    async runAll(maxRounds = MAX_ROUNDS) {
      for (let i = 0; i < maxRounds; i++) {
        await flushMicrotasks();
        const next = due(Number.POSITIVE_INFINITY);
        if (!next) break;
        timers = timers.filter((t) => t.id !== next.id);
        now = Math.max(now, next.at);
        next.fn();
      }
      await flushMicrotasks();
    },
    flush: () => flushMicrotasks(),
    pending: () => timers.length,
    set(epochMs) {
      now = epochMs;
    },
  };
}

/** Deterministic `Random`: cycles through the supplied values. */
export function createFakeRandom(values: number | readonly number[] = 0.5): Random {
  const seq = typeof values === 'number' ? [values] : [...values];
  let i = 0;
  return {
    next: () => {
      const v = seq[i % seq.length]!;
      i++;
      return v;
    },
  };
}
