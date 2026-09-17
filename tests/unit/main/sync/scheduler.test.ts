import { describe, expect, it } from 'vitest';
import type { AuthState } from '../../../../src/shared/models';
import {
  createScheduler,
  DEFAULT_INTERVALS,
  type Scheduler,
  type SyncTrigger,
} from '../../../../src/main/sync/scheduler';
import { createFakeClock, type FakeClock } from '../../../fakes/fake-clock';
import { createSilentLogger } from '../../../fakes/fake-network';

interface Harness {
  clock: FakeClock;
  scheduler: Scheduler;
  cycles: Array<{ full: boolean; trigger: SyncTrigger }>;
  setAuth(s: AuthState): void;
  setFocused(f: boolean): void;
  setBattery(b: boolean): void;
  /** Hold the next cycle open until the returned function is called. */
  block(): () => void;
}

function harness(over: { focused?: boolean } = {}): Harness {
  const clock = createFakeClock();
  const cycles: Array<{ full: boolean; trigger: SyncTrigger }> = [];
  let auth: AuthState = 'signed_in';
  let focused = over.focused ?? true;
  let battery = false;
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;

  const scheduler = createScheduler({
    clock,
    logger: createSilentLogger(),
    runCycle: async (opts) => {
      cycles.push(opts);
      if (gate) {
        const g = gate;
        gate = null;
        await g;
      }
    },
    isOnline: () => true,
    authState: () => auth,
    isOnBattery: () => battery,
    isFocused: () => focused,
  });

  return {
    clock,
    scheduler,
    cycles,
    setAuth: (s) => {
      auth = s;
    },
    setFocused: (f) => {
      focused = f;
    },
    setBattery: (b) => {
      battery = b;
    },
    block() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release?.();
    },
  };
}

describe('scheduler triggers', () => {
  it('syncs at startup and then on the focused interval', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.flush();
    expect(h.cycles.map((c) => c.trigger)).toEqual(['startup']);

    await h.clock.advance(DEFAULT_INTERVALS.focusedMs);
    expect(h.cycles.map((c) => c.trigger)).toEqual(['startup', 'interval']);
  });

  it('polls every five minutes when unfocused, fifteen on battery', async () => {
    const h = harness({ focused: false });
    h.scheduler.start();
    await h.clock.flush();

    await h.clock.advance(DEFAULT_INTERVALS.focusedMs + 1);
    expect(h.cycles).toHaveLength(1); // not on the focused cadence

    await h.clock.advance(DEFAULT_INTERVALS.backgroundMs);
    expect(h.cycles).toHaveLength(2);

    // The cadence is chosen when a poll is armed, so unplugging takes effect
    // from the next scheduling point, not retroactively.
    h.setBattery(true);
    await h.clock.advance(DEFAULT_INTERVALS.backgroundMs);
    expect(h.cycles).toHaveLength(3);

    await h.clock.advance(DEFAULT_INTERVALS.backgroundMs + 1);
    expect(h.cycles).toHaveLength(3); // battery stretches it to 15 minutes
    await h.clock.advance(DEFAULT_INTERVALS.batteryMs);
    expect(h.cycles).toHaveLength(4);
  });

  it('window focus triggers a sync and tightens the cadence', async () => {
    const h = harness({ focused: false });
    h.scheduler.start();
    await h.clock.flush();
    h.setFocused(true);
    h.scheduler.setFocused(true);
    await h.clock.flush();
    expect(h.cycles.at(-1)!.trigger).toBe('focus');
    await h.clock.advance(DEFAULT_INTERVALS.focusedMs);
    expect(h.cycles.at(-1)!.trigger).toBe('interval');
  });

  it('regaining the network syncs; losing it stops the poll', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.flush();

    h.scheduler.networkChanged(false);
    await h.clock.advance(DEFAULT_INTERVALS.focusedMs * 3);
    expect(h.cycles).toHaveLength(1);

    h.scheduler.networkChanged(true);
    await h.clock.flush();
    expect(h.cycles.at(-1)!.trigger).toBe('network');
  });

  it('a long suspend forces a FULL reconcile on resume', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.flush();

    h.scheduler.powerResume(10 * 60_000);
    await h.clock.flush();
    expect(h.cycles.at(-1)).toMatchObject({ trigger: 'resume', full: false });

    h.scheduler.powerResume(2 * 3_600_000);
    await h.clock.flush();
    expect(h.cycles.at(-1)).toMatchObject({ trigger: 'resume', full: true });
  });
});

describe('scheduler local-edit debounce', () => {
  it('coalesces a burst of typing into one push', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.flush();
    h.cycles.length = 0;

    for (let i = 0; i < 10; i++) {
      h.scheduler.localEdit();
      await h.clock.advance(100);
    }
    expect(h.cycles).toHaveLength(0); // still typing

    await h.clock.advance(DEFAULT_INTERVALS.localEditDebounceMs);
    expect(h.cycles.map((c) => c.trigger)).toEqual(['local-edit']);
  });

  it('never waits longer than the max wait, however fast the user types', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.flush();
    h.cycles.length = 0;

    // An edit every 500ms would reset an unbounded debounce forever.
    const startedAt = h.clock.now();
    let firedAt: number | null = null;
    for (let i = 0; i < 30 && firedAt === null; i++) {
      h.scheduler.localEdit();
      await h.clock.advance(500);
      if (h.cycles.length > 0) firedAt = h.clock.now();
    }
    expect(firedAt).not.toBeNull();
    expect(firedAt! - startedAt).toBeLessThanOrEqual(DEFAULT_INTERVALS.localEditMaxWaitMs + 500);
    expect(h.cycles[0]!.trigger).toBe('local-edit');
  });
});

describe('scheduler single-flight', () => {
  it('a trigger during a cycle sets a resync flag instead of overlapping', async () => {
    const h = harness();
    const release = h.block();
    h.scheduler.start();
    await h.clock.flush();
    expect(h.cycles).toHaveLength(1);

    h.scheduler.manual(false).catch(() => {});
    h.scheduler.manual(false).catch(() => {});
    await h.clock.flush();
    expect(h.cycles).toHaveLength(1); // still just the one in flight

    release();
    await h.clock.flush();
    expect(h.cycles).toHaveLength(2); // the two requests collapsed into one
  });

  it('a full resync requested mid-cycle stays full', async () => {
    const h = harness();
    const release = h.block();
    h.scheduler.start();
    await h.clock.flush();

    h.scheduler.manual(true).catch(() => {});
    h.scheduler.manual(false).catch(() => {});
    release();
    await h.clock.flush();
    expect(h.cycles.at(-1)!.full).toBe(true);
  });

  it('manual() resolves when the cycle it waited on finishes', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.flush();
    let settled = false;
    const p = h.scheduler.manual(false).then(() => {
      settled = true;
    });
    await h.clock.flush();
    await p;
    expect(settled).toBe(true);
  });

  it('a cycle that throws never wedges the scheduler', async () => {
    const clock = createFakeClock();
    let calls = 0;
    const scheduler = createScheduler({
      clock,
      logger: createSilentLogger(),
      runCycle: () => {
        calls++;
        return Promise.reject(new Error('boom'));
      },
      isOnline: () => true,
      authState: () => 'signed_in',
      isOnBattery: () => false,
      isFocused: () => true,
    });
    scheduler.start();
    await clock.flush();
    expect(scheduler.isRunning()).toBe(false);
    await clock.advance(DEFAULT_INTERVALS.focusedMs);
    expect(calls).toBe(2);
  });
});

describe('scheduler pausing', () => {
  it('does nothing at all while signed out', async () => {
    const h = harness();
    h.setAuth('signed_out');
    h.scheduler.start();
    await h.clock.advance(DEFAULT_INTERVALS.focusedMs * 5);
    h.scheduler.localEdit();
    await h.clock.advance(DEFAULT_INTERVALS.localEditMaxWaitMs);
    expect(h.cycles).toHaveLength(0);
    expect(h.scheduler.nextPollAt()).toBeNull();
  });

  it('manual() resolves immediately rather than hanging when paused', async () => {
    const h = harness();
    h.setAuth('reauth_required');
    h.scheduler.start();
    await expect(h.scheduler.manual(false)).resolves.toBeUndefined();
    expect(h.cycles).toHaveLength(0);
  });

  it('signing in resumes with an immediate sync', async () => {
    const h = harness();
    h.setAuth('signed_out');
    h.scheduler.start();
    await h.clock.flush();
    expect(h.cycles).toHaveLength(0);

    h.setAuth('signed_in');
    h.scheduler.authChanged('signed_in');
    await h.clock.flush();
    expect(h.cycles.map((c) => c.trigger)).toEqual(['post-auth']);
    await h.clock.advance(DEFAULT_INTERVALS.focusedMs);
    expect(h.cycles.at(-1)!.trigger).toBe('interval');
  });

  it('stop() cancels the poll and any pending debounce', async () => {
    const h = harness();
    h.scheduler.start();
    await h.clock.flush();
    h.scheduler.localEdit();
    h.scheduler.stop();
    await h.clock.advance(DEFAULT_INTERVALS.focusedMs * 3);
    expect(h.cycles).toHaveLength(1);
    expect(h.clock.pending()).toBe(0);
  });
});
