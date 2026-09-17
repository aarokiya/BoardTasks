import { BrowserWindow } from 'electron';
import type { TokenProvider } from '../auth/types';
import { DEFAULT_SETTINGS } from '@shared/models';
import { createLogger } from '../logger';
import { googleBaseUrl } from '../env';
import { createHttpClient, type FetchLike } from '../api/http-client';
import { createGoogleTasksApi, resolveBaseUrl } from '../api/google-tasks';
import { createRequestQueue } from '../api/request-queue';
import { emit } from '../ipc/emitter';
import { counts } from '../db/repositories/outbox';
import { getSettings, onSettingsChanged } from '../db/repositories/settings';
import { setSyncEngine } from '../ipc/routes/sync';
import { SystemClock, SystemRandom } from './clock';
import { createSyncEngine, type SyncEngine } from './engine';
import { createElectronNetworkPlatform, electronFetch, isOnBatteryPower } from './electron-platform';
import { installSyncHooks } from './hooks';
import { createNetworkMonitor } from './network-monitor';
import { intervalsFromSetting } from './scheduler';

/**
 * One call from bootstrap wires the whole engine up:
 *
 *   import { startSync } from './sync';
 *   const sync = startSync({ tokens });            // after auth + DB are ready
 *   app.on('before-quit', () => sync.stop());
 *
 * `tokens` is the auth track's TokenProvider. Everything else is built here.
 */
export interface StartSyncOptions {
  tokens: TokenProvider;
  /** Override for tests / the E2E fake server. Defaults to Electron's net.fetch. */
  fetch?: FetchLike;
  baseUrl?: string;
}

export function startSync(opts: StartSyncOptions): SyncEngine {
  const logger = createLogger('sync');
  const clock = SystemClock;
  const random = SystemRandom;
  const doFetch = opts.fetch ?? electronFetch;

  const http = createHttpClient({
    baseUrl: opts.baseUrl ?? resolveBaseUrl(googleBaseUrl),
    fetch: doFetch,
    tokens: opts.tokens,
    clock,
    random,
    logger,
  });
  const api = createGoogleTasksApi(http);
  const queue = createRequestQueue({ clock, logger });
  const isFocused = (): boolean => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());

  const network = createNetworkMonitor({
    clock,
    fetch: doFetch,
    logger,
    random,
    platform: createElectronNetworkPlatform(),
    // Probe the host we actually need, not a third-party "generate 204" that a
    // firewall or a CI sandbox can black-hole while Google is perfectly fine.
    probeUrl: http.baseUrl,
    // Unsent work or a user watching earns a 60s reconnect beat; an idle
    // background app settles for 5 minutes and leaves the radio alone.
    isUrgent: () => {
      try {
        return counts().pending > 0 || isFocused();
      } catch {
        return false;
      }
    },
  });

  const engine = createSyncEngine({
    api,
    tokens: opts.tokens,
    clock,
    random,
    network,
    queue,
    logger,
    emit,
    isOnBattery: isOnBatteryPower,
    isFocused,
    intervals: intervalsFromSetting(readSyncIntervalSec()),
  });

  // The setting is a live control, not a startup constant: changing it in
  // Settings must re-arm the poll that is already pending.
  const offSettings = onSettingsChanged((s, changed) => {
    if (changed.includes('syncIntervalSec')) engine.setIntervals(intervalsFromSetting(s.syncIntervalSec));
  });

  // The seam the routes already call after every mutation.
  installSyncHooks({ onLocalEdit: () => engine.localEdit() });
  setSyncEngine(engine);
  engine.start();
  return {
    ...engine,
    stop() {
      offSettings();
      engine.stop();
    },
  };
}

function readSyncIntervalSec(): number {
  try {
    return getSettings().syncIntervalSec;
  } catch {
    return DEFAULT_SETTINGS.syncIntervalSec;
  }
}
