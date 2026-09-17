import type { Logger } from '../logger';
import type { FetchLike } from '../api/http-client';
import type { Clock, Random, TimerHandle } from './clock';
import { SystemRandom } from './clock';
import { ApiError, NetworkError } from '../api/errors';

/**
 * `navigator.onLine` is a lie — it is true on a captive portal and on a dead
 * VPN — and it lives in the wrong process anyway. So:
 *
 *  - Electron's `net.isOnline()` is a NEGATIVE signal only (false really means
 *    no route; true means very little).
 *  - Real request outcomes are the authoritative POSITIVE signal.
 *  - On a transition we HEAD-probe the API's own origin with a 5s timeout.
 *    Probing the host we actually need is the point: a third-party "generate
 *    204" endpoint can be blocked, firewalled or simply absent in CI while
 *    Google is perfectly reachable, and then sync stays wedged offline.
 *  - ANY HTTP answer from that origin — 401, 404, 405 — means reachable; we
 *    are testing the route, not the endpoint. A redirect to a FOREIGN host is
 *    a captive portal, the state where every other signal says "online" and
 *    nothing works. Only a transport error means offline.
 *  - powerMonitor suspend forces us offline immediately: in-flight requests on
 *    a sleeping NIC hang for minutes instead of failing.
 *  - While offline we keep re-probing on a backoff. Without that the only way
 *    back is a request the scheduler will not make until its next poll, so a
 *    laptop that reconnects sits on a full outbox for up to five minutes.
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

/** Fallback only; production and E2E both pass the API base URL. */
export const PROBE_URL = 'https://tasks.googleapis.com/tasks/v1';
export const PROBE_TIMEOUT_MS = 5_000;
/** Consecutive network failures before we stop believing we're online. */
export const FAILURES_BEFORE_OFFLINE = 2;

/**
 * Reconnect cadence while offline or behind a captive portal: 3s, 6s, 12s,
 * 30s, then a steady beat — every 60s while there is queued work or the user
 * is looking at the app, every 5 minutes otherwise, because an idle backgrounded
 * app waking the radio twice a minute is a battery complaint waiting to happen.
 * Each delay carries ±15% jitter so a fleet of clients does not stampede a
 * recovering network in lockstep.
 */
export const RECONNECT_STEPS_MS = [3_000, 6_000, 12_000, 30_000] as const;
export const RECONNECT_MAX_MS = 60_000;
export const RECONNECT_IDLE_MAX_MS = 300_000;

export interface NetworkMonitorOptions {
  clock: Clock;
  fetch: FetchLike;
  logger: Logger;
  platform?: NetworkPlatform;
  /** Jitter source for the reconnect backoff. */
  random?: Random;
  /** HEAD target. Pass the API base URL so the probe tests the real path. */
  probeUrl?: string;
  probeTimeoutMs?: number;
  /**
   * True while reconnecting promptly is worth the radio: queued outbox work,
   * or a focused window. Caps the backoff at 60s instead of 5 minutes.
   */
  isUrgent?: () => boolean;
}

export function createNetworkMonitor(opts: NetworkMonitorOptions): NetworkMonitor {
  const { clock, fetch: doFetch, logger } = opts;
  const platform = opts.platform ?? NULL_PLATFORM;
  const random = opts.random ?? SystemRandom;
  const probeUrl = opts.probeUrl ?? PROBE_URL;
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probeHost = hostOf(probeUrl);
  const isUrgent = opts.isUrgent ?? ((): boolean => false);

  let current: NetStatus = platform.isOnline() ? 'online' : 'offline';
  let failures = 0;
  let suspended = false;
  let started = false;
  let unsubPower: (() => void) | null = null;
  let probing: Promise<NetStatus> | null = null;
  let reconnectTimer: TimerHandle | null = null;
  let attempt = 0;
  let platformOnline = platform.isOnline();
  const listeners = new Set<(s: NetStatus) => void>();

  function set(next: NetStatus, why: string): void {
    if (next === current) return;
    logger.info(`network ${current} -> ${next} (${why})`);
    current = next;
    // Any real transition restarts the cadence: coming back from a five-minute
    // beat straight into another outage should retry in 3s, not 5 minutes.
    attempt = 0;
    for (const cb of [...listeners]) cb(next);
    if (next === 'online') clearReconnect();
    else scheduleReconnect();
  }

  function clearReconnect(): void {
    clock.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  /** Next reconnect delay, jittered ±15%. */
  function reconnectDelay(): number {
    const step = RECONNECT_STEPS_MS[attempt];
    const base = step ?? (isUrgent() ? RECONNECT_MAX_MS : RECONNECT_IDLE_MAX_MS);
    attempt++;
    return Math.max(1, Math.round(base * (0.85 + random.next() * 0.3)));
  }

  function scheduleReconnect(): void {
    clearReconnect();
    if (!started || suspended || current === 'online') return;
    const ms = reconnectDelay();
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      void reconnectTick();
    }, ms);
  }

  /**
   * One reconnect attempt. `net.isOnline() === false` means there is provably
   * no route, so we skip the request entirely and just keep watching — Electron
   * exposes no event for the flip back, so polling the cheap local call is the
   * only way to notice it.
   */
  async function reconnectTick(): Promise<void> {
    const online = platform.isOnline();
    const regained = online && !platformOnline;
    platformOnline = online;
    if (!online) {
      // No request to burn, so don't let the backoff drift past a minute:
      // this is a local call, and it is how we learn the route is back.
      if (attempt > RECONNECT_STEPS_MS.length) attempt = RECONNECT_STEPS_MS.length;
      scheduleReconnect();
      return;
    }
    if (regained) {
      logger.info('net.isOnline() flipped back to true; probing immediately');
      attempt = 0;
    }
    await probe();
    if (current !== 'online') scheduleReconnect();
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
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        return location && hostOf(location) !== probeHost ? 'captive_portal' : 'online';
      }
      // Any answer at all from the API's own origin proves the route: a HEAD
      // of the collection root is a 404 or a 401 on a healthy Google, and
      // demanding a particular status would call a working network broken.
      return 'online';
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
      // Only a transport failure is evidence. A 403 means we reached Google —
      // but a parse error on an HTML 200 (captive portal) is not proof of anything.
      if (!(error instanceof NetworkError)) {
        failures = 0;
        if (error instanceof ApiError && current !== 'online' && !suspended) set('online', 'server responded');
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
      started = true;
      unsubPower ??= platform.onPower((event) => {
        if (event === 'suspend') {
          suspended = true;
          clearReconnect();
          set('offline', 'system suspend');
        } else {
          suspended = false;
          // A wake is a fresh start, not a continuation of the pre-sleep
          // backoff: an hour asleep must not inherit a five-minute beat.
          attempt = 0;
          platformOnline = platform.isOnline();
          // The NIC comes back after the process does; probe rather than guess.
          clock.setTimeout(() => {
            void probe().then(() => {
              if (current !== 'online') scheduleReconnect();
            });
          }, 3_000);
        }
      });
      platformOnline = platform.isOnline();
      set(platformOnline ? current : 'offline', 'start');
      // `set` only fires on a CHANGE, so a monitor that starts out offline
      // needs the reconnect loop armed explicitly.
      if (current !== 'online' && reconnectTimer === null) scheduleReconnect();
    },

    stop() {
      started = false;
      clearReconnect();
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
