import type { AuthState } from '@shared/models';
import type { Logger } from '../logger';
import type { Clock, TimerHandle } from './clock';

/**
 * Decides *when* a sync cycle runs. Push eagerly, pull on a rhythm: pulling on
 * every keystroke could yank a remote edit into the field being typed in.
 *
 * Exactly one cycle runs at a time. A trigger that arrives mid-cycle sets
 * `resyncRequested` instead of starting a second one — overlapping cycles
 * would double-push the outbox.
 */

export interface SchedulerIntervals {
  focusedMs: number;
  backgroundMs: number;
  batteryMs: number;
  /** Coalesce a burst of typing into one push. */
  localEditDebounceMs: number;
  /** ...but never wait longer than this before pushing. */
  localEditMaxWaitMs: number;
}

/**
 * Poll cadence derived from the user's `syncIntervalSec` setting.
 *
 * Only the focused rhythm follows the setting literally. A background or
 * battery cadence that honoured "every 15 seconds" would drain a laptop for no
 * benefit, so those are multiples with a floor: at least 5 minutes in the
 * background, at least 15 on battery.
 */
export function intervalsFromSetting(syncIntervalSec: number): Pick<SchedulerIntervals, 'focusedMs' | 'backgroundMs' | 'batteryMs'> {
  const sec = Math.max(15, Math.min(3600, Math.round(syncIntervalSec)));
  return {
    focusedMs: sec * 1000,
    backgroundMs: Math.max(5 * sec, 300) * 1000,
    batteryMs: Math.max(15 * sec, 900) * 1000,
  };
}

export const DEFAULT_INTERVALS: SchedulerIntervals = {
  focusedMs: 60_000,
  backgroundMs: 300_000,
  batteryMs: 900_000,
  localEditDebounceMs: 800,
  localEditMaxWaitMs: 5_000,
};

/**
 * A backoff wake never fires sooner than this after a cycle. A push only ever
 * reports a `retryAt` ahead of the moment it ran, but a slow cycle can outlast
 * a short backoff, and "immediately" must still not mean a busy loop.
 */
export const MIN_RETRY_WAKE_MS = 250;

export type SyncTrigger = 'startup' | 'interval' | 'focus' | 'network' | 'resume' | 'local-edit' | 'manual' | 'post-auth' | 'retry';

/** What a cycle learned that changes when the next one should run. */
export interface CycleOutcome {
  /**
   * Epoch ms at which an outbox entry's backoff elapses. The scheduler wakes
   * for it (while online) instead of leaving the entry to the next poll.
   */
  retryAt: number | null;
}

export interface SchedulerDeps {
  clock: Clock;
  logger: Logger;
  /** Runs one full cycle (push then pull). Must never reject. */
  runCycle(opts: { full: boolean; trigger: SyncTrigger }): Promise<CycleOutcome | void>;
  isOnline(): boolean;
  authState(): AuthState;
  /** `powerMonitor.isOnBatteryPower()`, injected. */
  isOnBattery(): boolean;
  isFocused(): boolean;
  intervals?: Partial<SchedulerIntervals>;
  /**
   * A floor for the next poll, in ms. The engine uses it to park the cycle
   * until a `Retry-After` expires instead of hammering a throttled account on
   * the ordinary rhythm. Manual syncs bypass it — the user asked.
   */
  nextPollFloorMs?: () => number;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** A local mutation landed in the outbox. */
  localEdit(): void;
  /** User asked for a sync. Resolves when the resulting cycle finishes. */
  manual(full: boolean): Promise<void>;
  setFocused(focused: boolean): void;
  /** Change the cadence live (the sync-interval setting). Re-arms a pending poll. */
  setIntervals(next: Partial<SchedulerIntervals>): void;
  networkChanged(online: boolean): void;
  powerResume(suspendedMs: number): void;
  authChanged(state: AuthState): void;
  isRunning(): boolean;
  /** Next scheduled poll, epoch ms, or null when paused. */
  nextPollAt(): number | null;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let intervals: SchedulerIntervals = { ...DEFAULT_INTERVALS, ...deps.intervals };
  const { clock, logger } = deps;

  let started = false;
  let running = false;
  let resyncRequested: { full: boolean; trigger: SyncTrigger } | null = null;
  let pollTimer: TimerHandle | null = null;
  let pollAt: number | null = null;
  let debounceTimer: TimerHandle | null = null;
  let debounceDeadline: number | null = null;
  /** Soonest outbox backoff expiry reported by the last cycle, epoch ms. */
  let retryAt: number | null = null;
  const waiters: Array<() => void> = [];

  function pollIntervalMs(): number {
    if (deps.isFocused()) return intervals.focusedMs;
    return deps.isOnBattery() ? intervals.batteryMs : intervals.backgroundMs;
  }

  function paused(): boolean {
    return deps.authState() !== 'signed_in';
  }

  function clearPoll(): void {
    clock.clearTimeout(pollTimer);
    pollTimer = null;
    pollAt = null;
  }

  function schedulePoll(): void {
    clearPoll();
    if (!started || paused()) return;
    // Never poll sooner than the server told us to wait.
    const floor = deps.nextPollFloorMs?.() ?? 0;
    let ms = Math.max(pollIntervalMs(), floor);
    let reason: SyncTrigger = 'interval';
    // An entry in backoff earns an earlier wake — but only while online. Offline,
    // every wake would fail, burn an attempt, and park the entry within minutes;
    // the network transition itself re-triggers a cycle when the route is back.
    if (retryAt !== null && deps.isOnline()) {
      const wait = Math.max(retryAt - clock.now(), floor, MIN_RETRY_WAKE_MS);
      if (wait < ms) {
        ms = wait;
        reason = 'retry';
      }
    }
    pollAt = clock.now() + ms;
    pollTimer = clock.setTimeout(() => {
      pollTimer = null;
      pollAt = null;
      trigger(reason, false);
    }, ms);
  }

  function clearDebounce(): void {
    clock.clearTimeout(debounceTimer);
    debounceTimer = null;
    debounceDeadline = null;
  }

  function trigger(reason: SyncTrigger, full: boolean): void {
    if (!started) return;
    if (paused()) {
      logger.debug(`sync trigger ${reason} ignored: not signed in`);
      return;
    }
    if (running) {
      resyncRequested = { full: (resyncRequested?.full ?? false) || full, trigger: reason };
      return;
    }
    void cycle(reason, full);
  }

  async function cycle(reason: SyncTrigger, full: boolean): Promise<void> {
    running = true;
    clearPoll();
    // Whatever the previous cycle learned is stale once a new one runs: it
    // will re-examine every entry and report afresh.
    retryAt = null;
    try {
      const outcome = await deps.runCycle({ full, trigger: reason });
      if (outcome) retryAt = outcome.retryAt;
    } catch (e) {
      // runCycle owns its error reporting; this is belt and braces so the
      // scheduler can never wedge in `running = true`.
      logger.error('sync cycle threw', e);
    } finally {
      running = false;
      const again = resyncRequested;
      resyncRequested = null;
      if (again) {
        // A trigger arrived mid-cycle, so this cycle did not include whatever
        // provoked it. Leave `manual`'s callers waiting for the follow-up:
        // resolving them here would report a result that predates the click.
        void cycle(again.trigger, again.full);
      } else {
        for (const w of waiters.splice(0)) w();
        schedulePoll();
      }
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      trigger('startup', false);
      schedulePoll();
    },

    stop() {
      started = false;
      clearPoll();
      clearDebounce();
      resyncRequested = null;
      for (const w of waiters.splice(0)) w();
    },

    localEdit() {
      if (!started || paused()) return;
      const now = clock.now();
      debounceDeadline ??= now + intervals.localEditMaxWaitMs;
      clock.clearTimeout(debounceTimer);
      const wait = Math.max(0, Math.min(intervals.localEditDebounceMs, debounceDeadline - now));
      debounceTimer = clock.setTimeout(() => {
        clearDebounce();
        trigger('local-edit', false);
      }, wait);
    },

    manual(full) {
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (!started) started = true;
        if (paused()) {
          // Nothing will run; don't leave the caller hanging.
          for (const w of waiters.splice(0)) w();
          return;
        }
        trigger('manual', full);
      });
    },

    setFocused(focused) {
      if (focused) trigger('focus', false);
      schedulePoll(); // the cadence itself changes with focus
    },

    setIntervals(next) {
      intervals = { ...intervals, ...next };
      logger.debug(`sync cadence: ${intervals.focusedMs}ms focused / ${intervals.backgroundMs}ms background / ${intervals.batteryMs}ms on battery`);
      // A poll already armed for the old cadence would otherwise hold the old
      // rhythm until it fired, which makes the setting look inert.
      if (pollTimer !== null) schedulePoll();
    },

    networkChanged(online) {
      if (online) trigger('network', false);
      else clearPoll();
    },

    powerResume(suspendedMs) {
      // A laptop asleep for an hour may have missed a great deal; and if
      // tombstones didn't flow we need the key-set diff to catch deletes.
      trigger('resume', suspendedMs > 3_600_000);
    },

    authChanged(state) {
      if (state === 'signed_in') trigger('post-auth', false);
      else clearPoll();
    },

    isRunning: () => running,
    nextPollAt: () => pollAt,
  };
}
