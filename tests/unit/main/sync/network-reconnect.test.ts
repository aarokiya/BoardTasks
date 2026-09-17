import { describe, expect, it } from 'vitest';

import { NetworkError } from '../../../../src/main/api/errors';
import type { FetchLike, FetchResponseLike } from '../../../../src/main/api/http-client';
import {
  createNetworkMonitor,
  RECONNECT_IDLE_MAX_MS,
  RECONNECT_MAX_MS,
  RECONNECT_STEPS_MS,
  type NetStatus,
  type NetworkPlatform,
} from '../../../../src/main/sync/network-monitor';
import { createFakeClock, createFakeRandom } from '../../../fakes/fake-clock';
import { createSilentLogger } from '../../../fakes/fake-network';

/**
 * Getting back online.
 *
 * Without a reconnect loop the only route out of `offline` is a request the
 * scheduler will not make until its next poll — so a laptop that reconnects
 * sits on a full outbox for up to five minutes. The cadence is 3s, 6s, 12s,
 * 30s, then 60s while the work matters or 5 minutes while it does not.
 */

const PROBE = 'https://tasks.example/tasks/v1';

interface Options {
  nativeOnline?: boolean;
  urgent?: boolean;
}

function harness(opts: Options = {}) {
  const clock = createFakeClock();
  // 0.5 → the jitter factor is exactly 1.0, so delays are the nominal values.
  const random = createFakeRandom(0.5);
  const probes: number[] = [];
  let power: ((e: 'suspend' | 'resume') => void) | null = null;
  let online = opts.nativeOnline ?? true;
  let reachable = false;

  const fetch: FetchLike = (url) => {
    expect(url).toBe(PROBE);
    probes.push(clock.now());
    if (!reachable) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve<FetchResponseLike>({
      status: 404,
      headers: { get: () => null },
      text: () => Promise.resolve(''),
    });
  };

  const platform: NetworkPlatform = {
    isOnline: () => online,
    onPower: (h) => {
      power = h;
      return () => {
        power = null;
      };
    },
  };

  const monitor = createNetworkMonitor({
    clock,
    fetch,
    logger: createSilentLogger(),
    platform,
    random,
    probeUrl: PROBE,
    isUrgent: () => opts.urgent ?? true,
  });
  const seen: NetStatus[] = [];
  monitor.on('change', (s) => seen.push(s));

  return {
    clock,
    monitor,
    probes,
    seen,
    /** Delays between successive probe attempts. */
    gaps: (): number[] => probes.slice(1).map((t, i) => t - probes[i]!),
    heal: (): void => {
      reachable = true;
    },
    unheal: (): void => {
      reachable = false;
    },
    setNative: (v: boolean): void => {
      online = v;
    },
    power: (e: 'suspend' | 'resume'): void => power?.(e),
  };
}

/** Drive the monitor offline the way a failing cycle does. */
function goOffline(h: ReturnType<typeof harness>): void {
  h.monitor.start();
  h.monitor.noteFailure(new NetworkError(new Error('x'), false));
  h.monitor.noteFailure(new NetworkError(new Error('x'), false));
  expect(h.monitor.status()).toBe('offline');
}

describe('reconnect backoff', () => {
  it('re-probes on 3s, 6s, 12s, 30s and then every 60s while the work matters', async () => {
    const h = harness({ urgent: true });
    goOffline(h);
    // noteFailure probes immediately; that attempt is t0 of the ladder.
    expect(h.probes).toHaveLength(1);

    await h.clock.advance(200_000);
    expect(h.gaps().slice(0, 6)).toEqual([...RECONNECT_STEPS_MS, RECONNECT_MAX_MS, RECONNECT_MAX_MS]);
  });

  it('settles at five minutes when nothing is queued and nobody is looking', async () => {
    const h = harness({ urgent: false });
    goOffline(h);
    await h.clock.advance(20 * 60_000);
    expect(h.gaps().slice(0, 6)).toEqual([...RECONNECT_STEPS_MS, RECONNECT_IDLE_MAX_MS, RECONNECT_IDLE_MAX_MS]);
  });

  it('jitters each delay by ±15% so a fleet does not stampede', async () => {
    const clock = createFakeClock();
    const random = createFakeRandom([0, 1, 0, 1]);
    const probes: number[] = [];
    const monitor = createNetworkMonitor({
      clock,
      fetch: () => {
        probes.push(clock.now());
        return Promise.reject(new Error('down'));
      },
      logger: createSilentLogger(),
      platform: { isOnline: () => true, onPower: () => () => {} },
      random,
      probeUrl: PROBE,
      isUrgent: () => true,
    });
    monitor.start();
    monitor.noteFailure(new NetworkError(new Error('x'), false));
    monitor.noteFailure(new NetworkError(new Error('x'), false));

    await clock.advance(60_000);
    const gaps = probes.slice(1).map((t, i) => t - probes[i]!);
    // random 0 → ×0.85, random 1 → ×1.15.
    expect(gaps[0]).toBe(Math.round(RECONNECT_STEPS_MS[0] * 0.85));
    expect(gaps[1]).toBe(Math.round(RECONNECT_STEPS_MS[1] * 1.15));
  });

  it('stops probing the moment the route is back, and reports online once', async () => {
    const h = harness();
    goOffline(h);

    await h.clock.advance(4_000);
    h.heal();
    await h.clock.advance(10_000);

    expect(h.monitor.status()).toBe('online');
    expect(h.seen).toEqual(['offline', 'online']);
    const after = h.probes.length;
    await h.clock.advance(10 * 60_000);
    expect(h.probes.length, 'no probing while online').toBe(after);
  });

  it('restarts the ladder at 3s after any status change', async () => {
    const h = harness();
    goOffline(h);
    await h.clock.advance(200_000); // deep into the 60s beat
    h.heal();
    await h.clock.advance(RECONNECT_MAX_MS + 1_000);
    expect(h.monitor.status()).toBe('online');

    // Straight back down: the next attempt must be 3s, not 60s.
    h.unheal();
    h.monitor.noteFailure(new NetworkError(new Error('x'), false));
    h.monitor.noteFailure(new NetworkError(new Error('x'), false));
    await h.clock.flush();
    expect(h.monitor.status()).toBe('offline');
    const first = h.probes.length;
    await h.clock.advance(RECONNECT_STEPS_MS[0] + 100);
    expect(h.probes.length).toBeGreaterThan(first);
  });

  it('skips the request entirely while there is provably no route, and probes on the flip back', async () => {
    const h = harness({ nativeOnline: false });
    h.monitor.start();
    expect(h.monitor.status()).toBe('offline');
    h.probes.length = 0;

    // net.isOnline() === false: nothing to ask, so no request is made at all.
    await h.clock.advance(120_000);
    expect(h.probes).toHaveLength(0);

    // Electron exposes no event for the flip, so the same timer notices it.
    h.heal();
    h.setNative(true);
    await h.clock.advance(RECONNECT_MAX_MS + 1_000);
    expect(h.probes.length).toBeGreaterThan(0);
    expect(h.monitor.status()).toBe('online');
  });

  it('does not probe while suspended, and starts a fresh ladder on resume', async () => {
    const h = harness();
    goOffline(h);
    await h.clock.advance(200_000);

    h.power('suspend');
    h.probes.length = 0;
    await h.clock.advance(10 * 60_000);
    expect(h.probes, 'a sleeping NIC must not be poked').toHaveLength(0);

    h.power('resume');
    await h.clock.advance(3_500);
    expect(h.probes.length, 'the resume probe runs 3s after the wake').toBe(1);

    // …and the ladder resumes from the top rather than from the 60s beat.
    await h.clock.advance(RECONNECT_STEPS_MS[0] + 500);
    expect(h.probes.length).toBe(2);
  });

  it('stop() leaves no timer armed', async () => {
    const h = harness();
    goOffline(h);
    await h.clock.advance(5_000);
    h.monitor.stop();
    h.probes.length = 0;
    await h.clock.advance(10 * 60_000);
    expect(h.probes).toHaveLength(0);
  });
});
