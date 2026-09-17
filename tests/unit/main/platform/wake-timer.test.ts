import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWakeTimer } from '../../../../src/main/platform/wake-timer';
import { MAX_TIMER_MS } from '../../../../src/main/util/time';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createWakeTimer', () => {
  it('fires once at the armed instant', () => {
    const fire = vi.fn();
    const t = createWakeTimer(fire);
    t.armIn(5000);
    vi.advanceTimersByTime(4999);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(t.armedFor()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('chunks past the 2^31-1 setTimeout ceiling instead of firing immediately', () => {
    const fire = vi.fn();
    const t = createWakeTimer(fire);
    const target = Date.now() + MAX_TIMER_MS * 2 + 5000;
    t.armAt(target);

    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4999);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('never fires synchronously for a past target', () => {
    const fire = vi.fn();
    const t = createWakeTimer(fire);
    t.armAt(Date.now() - 10_000);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('re-arming replaces the pending arm', () => {
    const fire = vi.fn();
    const t = createWakeTimer(fire);
    t.armIn(5000);
    t.armIn(20_000);
    expect(t.armedFor()).toBe(Date.now() + 20_000);
    vi.advanceTimersByTime(10_000);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('cancel stops a pending arm', () => {
    const fire = vi.fn();
    const t = createWakeTimer(fire);
    t.armIn(5000);
    t.cancel();
    expect(t.armedFor()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(fire).not.toHaveBeenCalled();
  });
});
