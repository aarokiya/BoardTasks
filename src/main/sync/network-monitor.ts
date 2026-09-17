import type { Logger } from '../logger';
import type { FetchLike } from '../api/http-client';
import type { Clock } from './clock';
import { NetworkError } from '../api/errors';

/**
 * `navigator.onLine` is a lie — it is true on a captive portal and on a dead
 * VPN — and it lives in the wrong process anyway. So:
 *
 *  - Electron's `net.isOnline()` is a NEGATIVE signal only (false really means
 *    no route; true means very little).
 *  - Real request outcomes are the authoritative POSITIVE signal.
 *  - On a transition we HEAD-probe a known 204 endpoint with a 5s timeout.
 *  - A probe that answers with anything other than 204 — a redirect to a
 *    foreign host, or a 200 with a login page — is a captive portal, which is
 *    the state where every other signal says "online" and nothing works.
 *  - powerMonitor suspend forces us offline immediately: in-flight requests on
 *    a sleeping NIC hang for minutes instead of failing.
 */

export type NetStatus = 'online' | 'offline' | 'captive_portal';

export interface NetworkMonitor {
  isOnline(): boolean;
  status(): NetStatus;
  on(event: 'change', cb: (s: NetStatus) => void): () => void;
  /** A request completed successfully — the strongest possible positive signal. */
  noteSuccess(): void;
  /** A request failed. Only NetworkError counts as evidence of being offline. */
  noteFailure(error: unknown): void;
  /** Re-probe now (used on resume and on manual sync). */
  probe(): Promise<NetStatus>;
  start(): void;
  stop(): void;
}

/** The Electron bits, injected so unit tests never load electron. */
export interface NetworkPlatform {
  /** `net.isOnline()`. Negative signal only. */
  isOnline(): boolean;
  /** Subscribe to powerMonitor suspend/resume. Returns an unsubscribe. */
  onPower(handler: (event: 'suspend' | 'resume') => void): () => void;
}

export const NULL_PLATFORM: NetworkPlatform = {
  isOnline: () => true,
  onPower: () => () => {},
};

export const PROBE_URL = 'https://clients3.google.com/generate_204';
export const PROBE_TIMEOUT_MS = 5_000;
/** Consecutive network failures before we stop believing we're online. */
export const FAILURES_BEFORE_OFFLINE = 2;

export interface NetworkMonitorOptions {
  clock: Clock;
  fetch: FetchLike;
  logger: Logger;
  platform?: NetworkPlatform;
  probeUrl?: string;
  probeTimeoutMs?: number;
}

export function createNetworkMonitor(opts: NetworkMonitorOptions): NetworkMonitor {
  const { clock, fetch: doFetch, logger } = opts;
  const platform = opts.platform ?? NULL_PLATFORM;
  const probeUrl = opts.probeUrl ?? PROBE_URL;
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probeHost = hostOf(probeUrl);

  let current: NetStatus = platform.isOnline() ? 'online' : 'offline';
  let failures = 0;
  let suspended = false;
  let unsubPower: (() => void) | null = null;
  let probing: Promise<NetStatus> | null = null;
  const listeners = new Set<(s: NetStatus) => void>();

  function set(next: NetStatus, why: string): void {
    if (next === current) return;
    logger.info(`network ${current} -> ${next} (${why})`);
    current = next;
    for (const cb of [...listeners]) cb(next);
  }

  async function runProbe(): Promise<NetStatus> {
    if (suspended) return 'offline';
    if (!platform.isOnline()) return 'offline';
    const controller = new AbortController();
    const timer = clock.setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const res = await doFetch(probeUrl, {
        method: 'HEAD',
        headers: {},
        // `manual` is what makes captive-portal detection possible: following
        // the redirect would land on a 200 from the portal and look healthy.
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status === 204) return 'online';
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        return location && hostOf(location) !== probeHost ? 'captive_portal' : 'online';
      }
      // A 200 where a 204 was promised means something answered for the server.
      return res.status === 200 ? 'captive_portal' : 'online';
    } catch {
      return 'offline';
    } finally {
      clock.clearTimeout(timer);
    }
  }

  function probe(): Promise<NetStatus> {
    probing ??= runProbe()
      .then((s) => {
        if (s === 'online') failures = 0;
        set(s, 'probe');
        return s;
      })
      .finally(() => {
        probing = null;
      });
    return probing;
  }

  return {
    isOnline: () => current === 'online',
    status: () => current,

    on(_event, cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    noteSuccess() {
      failures = 0;
      if (current !== 'online') set('online', 'request succeeded');
    },

    noteFailure(error) {
      // Only a transport failure is evidence. A 403 means we reached Google.
      if (!(error instanceof NetworkError)) {
        failures = 0;
        if (current !== 'online' && !suspended) set('online', 'server responded');
        return;
      }
      failures++;
      if (!platform.isOnline()) {
        set('offline', 'net.isOnline() false');
        return;
      }
      if (failures >= FAILURES_BEFORE_OFFLINE && current === 'online') {
        set('offline', `${failures} consecutive network failures`);
        void probe();
      }
    },

    probe,

    start() {
      unsubPower ??= platform.onPower((event) => {
        if (event === 'suspend') {
          suspended = true;
          set('offline', 'system suspend');
        } else {
          suspended = false;
          // The NIC comes back after the process does; probe rather than guess.
          clock.setTimeout(() => void probe(), 3_000);
        }
      });
      set(platform.isOnline() ? current : 'offline', 'start');
    },

    stop() {
      unsubPower?.();
      unsubPower = null;
      listeners.clear();
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
