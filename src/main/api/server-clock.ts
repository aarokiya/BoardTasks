import type { Clock } from '../sync/clock';

/**
 * Skew estimate between this machine's wall clock and Google's.
 *
 * Why this exists: the pull watermark is compared against the SERVER's clock.
 * A laptop 45 seconds fast that sets the watermark from Date.now() asks for
 * "changes after a moment that hasn't happened server-side" and silently loses
 * every edit in that window, forever. We observe the HTTP `Date` header on
 * every response and use it — not local time — wherever a server instant is
 * needed.
 */
export interface ServerClock {
  /** Feed the `Date` response header (ignored when absent or unparseable). */
  observe(dateHeader: string | null): void;
  /** serverNow - localNow, in ms. Positive means the server is ahead of us. */
  skewMs(): number;
  /** Best estimate of the server's current epoch ms. */
  now(): number;
  /** The most recent `Date` header verbatim, or null if we've never seen one. */
  lastServerDate(): string | null;
  /** Number of samples observed (diagnostics / tests). */
  samples(): number;
}

/**
 * The `Date` header has one-second resolution and includes network latency, so
 * a single sample is noisy. We smooth with an EWMA but seed from the first
 * sample so the very first request already gives a usable estimate.
 */
const ALPHA = 0.25;

export function createServerClock(clock: Clock): ServerClock {
  let skew = 0;
  let count = 0;
  let lastDate: string | null = null;

  return {
    observe(dateHeader) {
      if (!dateHeader) return;
      const t = Date.parse(dateHeader);
      if (Number.isNaN(t)) return;
      lastDate = dateHeader;
      const sample = t - clock.now();
      skew = count === 0 ? sample : skew + ALPHA * (sample - skew);
      count++;
    },
    skewMs: () => Math.round(skew),
    now: () => clock.now() + Math.round(skew),
    lastServerDate: () => lastDate,
    samples: () => count,
  };
}
