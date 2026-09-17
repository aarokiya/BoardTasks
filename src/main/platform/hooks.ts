/**
 * Seam the rest of main uses to talk to the native layer (tray, dock badge,
 * notification scheduler) without importing any of it.
 *
 * `onTasksChanged` is a fan-out trigger, not a subscription: callers *call* it
 * after a mutation, and the native modules register themselves through
 * `subscribeTasksChanged`. Keeping the two directions on separate names is what
 * lets `syncHooks.onTasksChanged` forward here with a one-liner.
 */
import { createLogger } from '../logger';

const log = createLogger('platform');

export type Unsubscribe = () => void;

export interface PlatformHooks {
  /** Something changed the task set: refresh counts and re-arm reminders. */
  onTasksChanged(): void;
  /** Set by the integrator so the tray's "Sync Now" works with no window open. */
  syncNow?: () => void;
  /** Fires ~3s after the machine wakes, once the network stack is usable. */
  onResume(cb: () => void): Unsubscribe;
  onSuspend(cb: () => void): Unsubscribe;
}

const tasksChangedSubs = new Set<() => void>();
const resumeSubs = new Set<() => void>();
const suspendSubs = new Set<() => void>();

function subscribe(set: Set<() => void>, cb: () => void): Unsubscribe {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

/** One listener throwing must not stop the others; log it rather than swallow it. */
function fanOut(set: Set<() => void>, what: string): void {
  for (const cb of [...set]) {
    try {
      cb();
    } catch (e) {
      log.error(`${what} listener failed`, e);
    }
  }
}

export const platformHooks: PlatformHooks = {
  onTasksChanged: () => fanOut(tasksChangedSubs, 'tasksChanged'),
  onResume: (cb) => subscribe(resumeSubs, cb),
  onSuspend: (cb) => subscribe(suspendSubs, cb),
};

export function installPlatformHooks(h: Partial<PlatformHooks>): void {
  Object.assign(platformHooks, h);
}

/** Native modules register here; `platformHooks.onTasksChanged()` drives them. */
export function subscribeTasksChanged(cb: () => void): Unsubscribe {
  return subscribe(tasksChangedSubs, cb);
}

export function emitResume(): void {
  fanOut(resumeSubs, 'resume');
}

export function emitSuspend(): void {
  fanOut(suspendSubs, 'suspend');
}

/** Test seam: drop every registration so suites don't leak into each other. */
export function resetPlatformHooks(): void {
  tasksChangedSubs.clear();
  resumeSubs.clear();
  suspendSubs.clear();
  delete platformHooks.syncNow;
}
