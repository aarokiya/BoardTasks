import { app, BrowserWindow, nativeTheme, net } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createLogger, initLogger } from './logger';
import { githubBaseUrl, isDev, isE2E, skipOnboarding, userDataOverride } from './env';
import { openDatabase, closeDatabase } from './db/connection';
import { getSettings, onSettingsChanged, setSettings } from './db/repositories/settings';
import { installProtocolHandlers } from './security/protocols';
import { installCsp } from './security/csp';
import { hardenApp } from './security/harden';
import { registerRoutes } from './ipc/router';
import { buildRoutes } from './ipc/routes';
import { emit, flushEmitter } from './ipc/emitter';
import { createMainWindow, showMainWindow } from './windows/main-window';
import { initQuickAddWindow } from './windows/quick-add-window';
import { rendererDir } from './paths';
import { initAuthService } from './auth/auth-service';
import { startSync } from './sync';
import { initGithubService } from './github/service';
import { initPlatform, installPlatformHooks } from './platform';

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
  // The override is applied in index.ts, before the single-instance lock is
  // requested; re-applying it here is a no-op that keeps bootstrap() usable on
  // its own (tests, future entry points).
  if (userDataOverride) app.setPath('userData', userDataOverride);
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  // E2E gets debug too: the reminder scheduler's re-arm is only observable in
  // the log, and tests/e2e/06-features.spec.ts asserts on it.
  initLogger(join(userData, 'logs'), isDev || isE2E ? 'debug' : 'info');
  const log = createLogger('boot');
  log.info(`BoardTasks ${__APP_VERSION__} electron=${process.versions.electron} packaged=${app.isPackaged} e2e=${isE2E}`);

  const dbPath = join(userData, 'boardtasks.db');
  const { recoveredDb } = (() => {
    const r = openDatabase(dbPath);
    return { recoveredDb: r.recovered };
  })();

  // E2E seam: skip the onboarding wizard on a fresh profile.
  if (isE2E && skipOnboarding && !getSettings().onboardingComplete) {
    setSettings({ onboardingComplete: true });
  }
  // Test drivers expect "close the window" to mean quit; close-to-tray would leave the process alive.
  if (isE2E && getSettings().closeToTray) setSettings({ closeToTray: false, closeToTrayExplained: true });
  const settings = getSettings();
  nativeTheme.themeSource = settings.theme;

  // Auth before routes: signOut({wipeLocalData}) touches the DB, and the sync engine needs the TokenProvider.
  const auth = initAuthService();

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

  // Sync engine (self-pauses while signed out; outbox routes need it regardless).
  const sync = startSync({ tokens: auth });
  installPlatformHooks({ syncNow: () => void sync.syncNow({ full: false }) });

  // GitHub enrichment (works without a token: links are stored, enrichment skipped).
  const github = initGithubService({
    fetch: (url, init) => net.fetch(url, init),
    baseUrl: githubBaseUrl,
    isFocused: () => BrowserWindow.getFocusedWindow() !== null,
  });

  // Native integration LAST: it chains onto syncHooks.onTasksChanged, which startSync installed.
  const disposePlatform = initPlatform();
  if (recoveredDb) {
    emit({ type: 'toast', level: 'warn', message: 'The local database was damaged and has been recreated. Your tasks will re-download from Google.' });
    void sync.syncNow({ full: true });
  }

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
    disposePlatform();
    github.stop();
    sync.stop();
    flushEmitter();
    closeDatabase();
  });

  return { userData, dbPath, recoveredDb };
}
