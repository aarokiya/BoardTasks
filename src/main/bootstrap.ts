import { app, nativeTheme } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createLogger, initLogger } from './logger';
import { isDev, isE2E, userDataOverride } from './env';
import { openDatabase, closeDatabase } from './db/connection';
import { getSettings, onSettingsChanged } from './db/repositories/settings';
import { installProtocolHandlers } from './security/protocols';
import { installCsp } from './security/csp';
import { hardenApp } from './security/harden';
import { registerRoutes } from './ipc/router';
import { buildRoutes } from './ipc/routes';
import { emit, flushEmitter } from './ipc/emitter';
import { createMainWindow, showMainWindow } from './windows/main-window';
import { initQuickAddWindow } from './windows/quick-add-window';
import { rendererDir } from './paths';

export interface AppContext {
  userData: string;
  dbPath: string;
  recoveredDb: boolean;
}

/**
 * Ordered startup. Anything that can fail loudly should fail here, before a
 * window is shown, so the user sees a dialog instead of a blank screen.
 */
export function bootstrap(): AppContext {
  if (userDataOverride) app.setPath('userData', userDataOverride);
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  initLogger(join(userData, 'logs'), isDev ? 'debug' : 'info');
  const log = createLogger('boot');
  log.info(`BoardTasks ${__APP_VERSION__} electron=${process.versions.electron} packaged=${app.isPackaged} e2e=${isE2E}`);

  const dbPath = join(userData, 'boardtasks.db');
  const { recoveredDb } = (() => {
    const r = openDatabase(dbPath);
    return { recoveredDb: r.recovered };
  })();

  const settings = getSettings();
  nativeTheme.themeSource = settings.theme;

  installProtocolHandlers(rendererDir(), join(userData, 'cache', 'images'));
  installCsp(app.isPackaged);
  hardenApp();
  registerRoutes(buildRoutes());

  const statePath = join(userData, 'window-state.json');
  createMainWindow({
    statePath,
    themePreference: settings.theme,
    closeToTray: () => getSettings().closeToTray,
    showOnCreate: !process.argv.includes('--hidden'),
    translucent: settings.translucentSidebar,
  });

  // Quick Add is lazily created; this only installs the window hooks.
  initQuickAddWindow();

  nativeTheme.on('updated', () => {
    emit({ type: 'theme:changed', resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', preference: getSettings().theme });
  });
  onSettingsChanged((s, changed) => {
    if (changed.includes('theme')) nativeTheme.themeSource = s.theme;
  });

  app.on('activate', () => {
    if (!showMainWindow()) {
      createMainWindow({
        statePath,
        themePreference: getSettings().theme,
        closeToTray: () => getSettings().closeToTray,
        showOnCreate: true,
        translucent: getSettings().translucentSidebar,
      });
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    flushEmitter();
    closeDatabase();
  });

  return { userData, dbPath, recoveredDb };
}
