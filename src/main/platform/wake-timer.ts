/**
 * A single re-armable wake timer.
 *
 * setTimeout delays above 2^31-1 ms overflow to a 1ms delay in Node, so a
 * reminder six years out would fire immediately and then every tick after that.
 * We chunk instead: sleep at most MAX_TIMER_MS, wake, and re-arm for the
 * remainder until the target instant is actually reached.
 */
import { MAX_TIMER_MS } from '../util/time';

export interface WakeTimer {
  /** Arm for an absolute epoch-ms instant. Replaces any pending arm. */
  armAt(target: number): void;
  /** Arm for a relative delay in ms. */
  armIn(ms: number): void;
  cancel(): void;
  /** The instant currently armed for, or null. Exposed for tests and logging. */
  armedFor(): number | null;
}

export function createWakeTimer(fire: () => void, now: () => number = Date.now): WakeTimer {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let target: number | null = null;

  const clear = (): void => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };

  const tick = (): void => {
    handle = null;
    if (target === null) return;
    if (now() >= target) {
      target = null;
      fire();
      return;
    }
    schedule();
  };

  // Never fires synchronously from armAt(): a past target still goes through a
  // 0ms timer, so callers can't re-enter themselves mid-rearm.
  const schedule = (): void => {
    clear();
    if (target === null) return;
    const remaining = Math.max(0, target - now());
    handle = setTimeout(tick, Math.min(remaining, MAX_TIMER_MS));
    handle.unref?.();
  };

  return {
    armAt(t) {
      target = t;
      schedule();
    },
    armIn(ms) {
      target = now() + ms;
      schedule();
    },
    cancel() {
      target = null;
      clear();
    },
    armedFor: () => target,
  };
}
