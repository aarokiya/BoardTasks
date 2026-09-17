/**
 * Every source of nondeterminism in the sync engine goes through one of these.
 * No module under src/main/sync or src/main/api may call Date.now(),
 * Math.random(), setTimeout() or fetch() directly — a 24-hour backoff scenario
 * then runs in a millisecond under FakeClock instead of taking 24 hours.
 */

declare const timerBrand: unique symbol;
/** Opaque handle so a fake clock can hand back an index instead of a Timeout. */
export type TimerHandle = { readonly [timerBrand]: true };

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  nowIso(): string;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null): void;
}

export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
}

export const SystemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (h) => {
    if (h !== null) globalThis.clearTimeout(h as unknown as NodeJS.Timeout);
  },
};

export const SystemRandom: Random = { next: () => Math.random() };

/** `Date.prototype.toISOString` on an epoch — the one sanctioned conversion in sync code. */
export function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Parse an RFC3339 instant, returning null rather than NaN. */
export function parseInstant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Later of two RFC3339 instants; nulls lose. */
export function maxInstant(a: string | null, b: string | null): string | null {
  const ta = parseInstant(a);
  const tb = parseInstant(b);
  if (ta === null) return b;
  if (tb === null) return a;
  return ta >= tb ? a : b;
}
