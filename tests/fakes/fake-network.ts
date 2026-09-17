import type { Logger } from '../../src/main/logger';
import type { NetStatus, NetworkMonitor } from '../../src/main/sync/network-monitor';

export interface FakeNetworkMonitor extends NetworkMonitor {
  set(status: NetStatus): void;
  readonly successes: number;
  readonly failures: number;
}

export function createFakeNetwork(initial: NetStatus = 'online'): FakeNetworkMonitor {
  let status = initial;
  let successes = 0;
  let failures = 0;
  const listeners = new Set<(s: NetStatus) => void>();

  const monitor: FakeNetworkMonitor = {
    isOnline: () => status === 'online',
    status: () => status,
    on(_event, cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    noteSuccess() {
      successes++;
    },
    noteFailure() {
      failures++;
    },
    probe: () => Promise.resolve(status),
    start() {},
    stop() {
      listeners.clear();
    },
    set(next) {
      if (next === status) return;
      status = next;
      for (const cb of [...listeners]) cb(next);
    },
    get successes() {
      return successes;
    },
    get failures() {
      return failures;
    },
  };
  return monitor;
}

/** A logger that records instead of printing, so tests stay quiet. */
export function createSilentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (...a: unknown[]): void => {
      lines.push(`${level} ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}`);
    };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}
