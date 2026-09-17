import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '../../../../src/main/api/errors';
import type { FetchLike, FetchResponseLike } from '../../../../src/main/api/http-client';
import {
  createNetworkMonitor,
  FAILURES_BEFORE_OFFLINE,
  type NetStatus,
  type NetworkPlatform,
} from '../../../../src/main/sync/network-monitor';
import { createFakeClock } from '../../../fakes/fake-clock';
import { createSilentLogger } from '../../../fakes/fake-network';

interface ProbeScript {
  status: number;
  location?: string;
  throws?: boolean;
}

function harness(script: ProbeScript[] = [{ status: 204 }], nativeOnline = true) {
  const clock = createFakeClock();
  const probes: string[] = [];
  let power: ((e: 'suspend' | 'resume') => void) | null = null;
  let online = nativeOnline;
  let i = 0;

  const fetch: FetchLike = (url) => {
    probes.push(url);
    const s = script[Math.min(i, script.length - 1)]!;
    i++;
    if (s.throws) return Promise.reject(new Error('unreachable'));
    const headers = new Map<string, string>();
    if (s.location) headers.set('location', s.location);
    return Promise.resolve<FetchResponseLike>({
      status: s.status,
      headers: { get: (n) => headers.get(n.toLowerCase()) ?? null },
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

  const monitor = createNetworkMonitor({ clock, fetch, logger: createSilentLogger(), platform, probeTimeoutMs: 5_000 });
  const seen: NetStatus[] = [];
  monitor.on('change', (s) => seen.push(s));

  return {
    clock,
    monitor,
    probes,
    seen,
    setNative: (v: boolean) => {
      online = v;
    },
    power: (e: 'suspend' | 'resume') => power?.(e),
  };
}

describe('network-monitor signals', () => {
  it('starts online when net.isOnline() agrees', () => {
    const h = harness();
    h.monitor.start();
    expect(h.monitor.isOnline()).toBe(true);
  });

  it('net.isOnline() false is believed immediately — it is a reliable NEGATIVE', () => {
    const h = harness([{ status: 204 }], false);
    h.monitor.start();
    expect(h.monitor.status()).toBe('offline');
  });

  it('a successful request is the authoritative positive signal', () => {
    const h = harness([{ status: 204 }], false);
    h.monitor.start();
    expect(h.monitor.isOnline()).toBe(false);
    h.setNative(true);
    h.monitor.noteSuccess();
    expect(h.monitor.isOnline()).toBe(true);
    expect(h.seen).toContain('online');
  });

  it('needs two consecutive transport failures before declaring offline', async () => {
    const h = harness([{ status: 204 }]);
    h.monitor.start();
    for (let i = 0; i < FAILURES_BEFORE_OFFLINE - 1; i++) h.monitor.noteFailure(new NetworkError(new Error('x'), false));
    expect(h.monitor.isOnline()).toBe(true);
    h.monitor.noteFailure(new NetworkError(new Error('x'), false));
    expect(h.monitor.status()).toBe('offline');
    await h.clock.flush();
  });

  it('a 403 is NOT evidence of being offline — we reached Google', () => {
    const h = harness();
    h.monitor.start();
    for (let i = 0; i < 5; i++) h.monitor.noteFailure(new ApiError(403, null, false));
    expect(h.monitor.isOnline()).toBe(true);
  });

  it('a server response while offline flips us straight back online', () => {
    const h = harness([{ status: 204 }], false);
    h.monitor.start();
    h.setNative(true);
    h.monitor.noteFailure(new ApiError(500, null, true));
    expect(h.monitor.isOnline()).toBe(true);
  });
});

describe('network-monitor probing', () => {
  it('a 204 means genuinely online', async () => {
    const h = harness([{ status: 204 }], true);
    h.monitor.start();
    h.monitor.noteFailure(new NetworkError(new Error('x'), false));
    h.monitor.noteFailure(new NetworkError(new Error('x'), false));
    expect(h.monitor.status()).toBe('offline');
    await expect(h.monitor.probe()).resolves.toBe('online');
  });

  it('a redirect to a foreign host is a captive portal', async () => {
    const h = harness([{ status: 302, location: 'http://hotel-wifi.example/login' }]);
    h.monitor.start();
    await expect(h.monitor.probe()).resolves.toBe('captive_portal');
    expect(h.monitor.isOnline()).toBe(false);
    expect(h.seen).toContain('captive_portal');
  });

  it('a 200 where a 204 was promised is also a captive portal', async () => {
    const h = harness([{ status: 200 }]);
    h.monitor.start();
    await expect(h.monitor.probe()).resolves.toBe('captive_portal');
  });

  it('a redirect within the same host is not a portal', async () => {
    const h = harness([{ status: 302, location: 'https://clients3.google.com/elsewhere' }]);
    h.monitor.start();
    await expect(h.monitor.probe()).resolves.toBe('online');
  });

  it('probes with redirect:manual — following would land on the portal and look healthy', async () => {
    const h = harness([{ status: 204 }]);
    h.monitor.start();
    await h.monitor.probe();
    expect(h.probes).toHaveLength(1);
  });

  it('a failed probe means offline and never throws', async () => {
    const h = harness([{ throws: true, status: 0 }]);
    h.monitor.start();
    await expect(h.monitor.probe()).resolves.toBe('offline');
  });

  it('does not probe at all when net.isOnline() is already false', async () => {
    const h = harness([{ status: 204 }], false);
    h.monitor.start();
    await expect(h.monitor.probe()).resolves.toBe('offline');
    expect(h.probes).toHaveLength(0);
  });

  it('concurrent probe() calls share one in-flight probe', async () => {
    const h = harness([{ status: 204 }]);
    h.monitor.start();
    const [a, b] = await Promise.all([h.monitor.probe(), h.monitor.probe()]);
    expect([a, b]).toEqual(['online', 'online']);
    expect(h.probes).toHaveLength(1);
  });
});

describe('network-monitor power events', () => {
  it('suspend forces offline immediately — a sleeping NIC hangs requests for minutes', async () => {
    const h = harness();
    h.monitor.start();
    h.power('suspend');
    expect(h.monitor.status()).toBe('offline');
    // While suspended, even a probe stays offline.
    await expect(h.monitor.probe()).resolves.toBe('offline');
    expect(h.probes).toHaveLength(0);
  });

  it('resume re-probes after a settling delay rather than guessing', async () => {
    const h = harness([{ status: 204 }]);
    h.monitor.start();
    h.power('suspend');
    h.power('resume');
    expect(h.probes).toHaveLength(0);
    await h.clock.advance(3_000);
    expect(h.probes).toHaveLength(1);
    expect(h.monitor.status()).toBe('online');
  });

  it('stop() detaches the power listener and the change subscribers', () => {
    const h = harness();
    h.monitor.start();
    h.monitor.stop();
    h.seen.length = 0;
    h.monitor.noteFailure(new NetworkError(new Error('x'), false));
    h.monitor.noteFailure(new NetworkError(new Error('x'), false));
    expect(h.seen).toEqual([]);
  });
});
