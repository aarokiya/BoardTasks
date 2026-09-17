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

export const DEFAULT_INTERVALS: SchedulerIntervals = {
  focusedMs: 60_000,
  backgroundMs: 300_000,
  batteryMs: 900_000,
  localEditDebounceMs: 800,
  localEditMaxWaitMs: 5_000,
};

export type SyncTrigger = 'startup' | 'interval' | 'focus' | 'network' | 'resume' | 'local-edit' | 'manual' | 'post-auth';

export interface SchedulerDeps {
  clock: Clock;
  logger: Logger;
  /** Runs one full cycle (push then pull). Must never reject. */
  runCycle(opts: { full: boolean; trigger: SyncTrigger }): Promise<void>;
  isOnline(): boolean;
  authState(): AuthState;
  /** `powerMonitor.isOnBatteryPower()`, injected. */
  isOnBattery(): boolean;
  isFocused(): boolean;
  intervals?: Partial<SchedulerIntervals>;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** A local mutation landed in the outbox. */
  localEdit(): void;
  /** User asked for a sync. Resolves when the resulting cycle finishes. */
  manual(full: boolean): Promise<void>;
  setFocused(focused: boolean): void;
  networkChanged(online: boolean): void;
  powerResume(suspendedMs: number): void;
  authChanged(state: AuthState): void;
  isRunning(): boolean;
  /** Next scheduled poll, epoch ms, or null when paused. */
  nextPollAt(): number | null;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const intervals: SchedulerIntervals = { ...DEFAULT_INTERVALS, ...deps.intervals };
  const { clock, logger } = deps;

  let started = false;
  let running = false;
  let resyncRequested: { full: boolean; trigger: SyncTrigger } | null = null;
  let pollTimer: TimerHandle | null = null;
  let pollAt: number | null = null;
  let debounceTimer: TimerHandle | null = null;
  let debounceDeadline: number | null = null;
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
    const ms = pollIntervalMs();
    pollAt = clock.now() + ms;
    pollTimer = clock.setTimeout(() => {
      pollTimer = null;
      pollAt = null;
      trigger('interval', false);
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
    try {
      await deps.runCycle({ full, trigger: reason });
    } catch (e) {
      // runCycle owns its error reporting; this is belt and braces so the
      // scheduler can never wedge in `running = true`.
      logger.error('sync cycle threw', e);
    } finally {
      running = false;
      const again = resyncRequested;
      resyncRequested = null;
      for (const w of waiters.splice(0)) w();
      if (again) void cycle(again.trigger, again.full);
      else schedulePoll();
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
