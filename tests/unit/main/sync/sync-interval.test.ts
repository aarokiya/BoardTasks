import { describe, expect, it } from 'vitest';

import type { AuthState } from '../../../../src/shared/models';
import { DEFAULT_SETTINGS } from '../../../../src/shared/models';
import { createScheduler, intervalsFromSetting, type SyncTrigger } from '../../../../src/main/sync/scheduler';
import { createFakeClock } from '../../../fakes/fake-clock';
import { createSilentLogger } from '../../../fakes/fake-network';

/**
 * The `syncIntervalSec` setting was written by the Settings panel and read by
 * nobody: the scheduler always used its own constants.
 */

interface Opts {
  focused?: boolean;
  battery?: boolean;
  intervals?: Parameters<typeof createScheduler>[0]['intervals'];
}

function make(opts: Opts = {}) {
  const clock = createFakeClock();
  const ran: SyncTrigger[] = [];
  const scheduler = createScheduler({
    clock,
    logger: createSilentLogger(),
    runCycle: ({ trigger }) => {
      ran.push(trigger);
      return Promise.resolve();
    },
    isOnline: () => true,
    authState: (): AuthState => 'signed_in',
    isOnBattery: () => opts.battery ?? false,
    isFocused: () => opts.focused ?? true,
    intervals: opts.intervals,
  });
  return { clock, ran, scheduler };
}

describe('intervalsFromSetting', () => {
  it('follows the setting literally while focused', () => {
    expect(intervalsFromSetting(60).focusedMs).toBe(60_000);
    expect(intervalsFromSetting(15).focusedMs).toBe(15_000);
    expect(intervalsFromSetting(600).focusedMs).toBe(600_000);
  });

  it('holds a floor in the background and on battery, whatever the user picked', () => {
    // "Every 15 seconds" must not mean waking a sleeping laptop 240 times an hour.
    const fast = intervalsFromSetting(15);
    expect(fast.backgroundMs).toBe(300_000);
    expect(fast.batteryMs).toBe(900_000);
  });

  it('scales past the floor for a slow setting', () => {
    const slow = intervalsFromSetting(600);
    expect(slow.backgroundMs).toBe(5 * 600 * 1000);
    expect(slow.batteryMs).toBe(15 * 600 * 1000);
  });

  it('clamps to the range the settings schema allows', () => {
    expect(intervalsFromSetting(1).focusedMs).toBe(15_000);
    expect(intervalsFromSetting(99_999).focusedMs).toBe(3_600_000);
  });

  it('the default setting reproduces the shipped cadence', () => {
    const d = intervalsFromSetting(DEFAULT_SETTINGS.syncIntervalSec);
    expect(d).toEqual({ focusedMs: 60_000, backgroundMs: 300_000, batteryMs: 900_000 });
  });
});

describe('scheduler.setIntervals', () => {
  it('polls on the configured focused cadence', async () => {
    const h = make({ intervals: intervalsFromSetting(30) });
    h.scheduler.start();
    await h.clock.flush();
    expect(h.ran).toEqual(['startup']);

    await h.clock.advance(29_000);
    expect(h.ran).toEqual(['startup']);
    await h.clock.advance(2_000);
    expect(h.ran).toEqual(['startup', 'interval']);
  });

  it('re-arms the poll that is already pending, so the change is felt at once', async () => {
    const h = make({ intervals: intervalsFromSetting(600) });
    h.scheduler.start();
    await h.clock.flush();
    const before = h.scheduler.nextPollAt()!;

    h.scheduler.setIntervals(intervalsFromSetting(15));
    const after = h.scheduler.nextPollAt()!;
    expect(after).toBeLessThan(before);
    expect(after - h.clock.now()).toBe(15_000);

    await h.clock.advance(16_000);
    expect(h.ran).toEqual(['startup', 'interval']);
  });

  it('uses the background cadence when the window is not focused', async () => {
    const h = make({ focused: false, intervals: intervalsFromSetting(120) });
    h.scheduler.start();
    await h.clock.flush();
    expect(h.scheduler.nextPollAt()! - h.clock.now()).toBe(600_000);
  });

  it('uses the battery cadence on battery', async () => {
    const h = make({ focused: false, battery: true, intervals: intervalsFromSetting(120) });
    h.scheduler.start();
    await h.clock.flush();
    expect(h.scheduler.nextPollAt()! - h.clock.now()).toBe(1_800_000);
  });

  it('does not arm a poll out of nowhere when nothing was pending', () => {
    const h = make();
    h.scheduler.setIntervals(intervalsFromSetting(15));
    expect(h.scheduler.nextPollAt()).toBeNull();
  });
});

describe('scheduler poll floor', () => {
  it('never polls sooner than the floor the engine sets', async () => {
    const clock = createFakeClock();
    const ran: SyncTrigger[] = [];
    let floor = 0;
    const scheduler = createScheduler({
      clock,
      logger: createSilentLogger(),
      runCycle: ({ trigger }) => {
        ran.push(trigger);
        return Promise.resolve();
      },
      isOnline: () => true,
      authState: (): AuthState => 'signed_in',
      isOnBattery: () => false,
      isFocused: () => true,
      intervals: intervalsFromSetting(15),
      nextPollFloorMs: () => floor,
    });

    floor = 120_000; // as if Google said Retry-After: 120
    scheduler.start();
    await clock.flush();
    expect(scheduler.nextPollAt()! - clock.now()).toBe(120_000);

    await clock.advance(60_000);
    expect(ran).toEqual(['startup']);

    floor = 0;
    await clock.advance(61_000);
    expect(ran).toEqual(['startup', 'interval']);
    scheduler.stop();
  });
});
