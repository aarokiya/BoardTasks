import { BrowserWindow } from 'electron';
import type { TokenProvider } from '../auth/types';
import { createLogger } from '../logger';
import { googleBaseUrl } from '../env';
import { createHttpClient, type FetchLike } from '../api/http-client';
import { createGoogleTasksApi, resolveBaseUrl } from '../api/google-tasks';
import { createRequestQueue } from '../api/request-queue';
import { emit } from '../ipc/emitter';
import { setSyncEngine } from '../ipc/routes/sync';
import { SystemClock, SystemRandom } from './clock';
import { createSyncEngine, type SyncEngine } from './engine';
import { createElectronNetworkPlatform, electronFetch, isOnBatteryPower } from './electron-platform';
import { installSyncHooks } from './hooks';
import { createNetworkMonitor } from './network-monitor';

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
  const network = createNetworkMonitor({ clock, fetch: doFetch, logger, platform: createElectronNetworkPlatform() });

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
    isFocused: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()),
  });

  // The seam the routes already call after every mutation.
  installSyncHooks({ onLocalEdit: () => engine.localEdit() });
  setSyncEngine(engine);
  engine.start();
  return engine;
}
