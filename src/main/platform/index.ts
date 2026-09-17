/**
 * Native macOS integration, started as one unit so the ordering dependencies
 * between the pieces are stated in exactly one place.
 */
import { createLogger } from '../logger';
import { emit } from '../ipc/emitter';
import { installWindowHooks } from '../windows/hooks';
import { showMainWindow } from '../windows/main-window';
import { installSyncHooks, syncHooks } from '../sync/hooks';
import { initNotificationScheduler } from '../notifications/scheduler';
import { platformHooks } from './hooks';
import { initPowerMonitor } from './power';
import { initLoginItem } from './login-item';
import { initTray } from './tray';
import { installAppMenu } from './app-menu';
import { initDockBadge } from './dock-badge';
import { initGlobalShortcut } from './shortcuts';
import { initCloseToTray } from './close-to-tray';

const log = createLogger('platform');

export function initPlatform(): () => void {
  // 1. Window seams first: the tray, the menu and notifications all summon windows.
  installWindowHooks({
    showMain: () => {
      showMainWindow();
    },
    focusTask: (taskId) => {
      showMainWindow();
      emit({ type: 'focusTask', taskId });
    },
  });

  // 2. Forward the data-layer seam into the native one, additively — whatever
  //    the sync track installed keeps running. (So: install sync hooks first.)
  const previousOnTasksChanged = syncHooks.onTasksChanged.bind(syncHooks);
  installSyncHooks({
    onTasksChanged: () => {
      previousOnTasksChanged();
      platformHooks.onTasksChanged();
    },
  });

  // 3. Everything else. The resume/tasksChanged listener registries live in
  //    hooks.ts, so these are order-independent among themselves.
  const disposers = [initPowerMonitor(), initLoginItem(), initTray(), installAppMenu(), initDockBadge(), initGlobalShortcut(), initCloseToTray(), initNotificationScheduler()];

  log.info('platform integration ready');
  return () => {
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch (e) {
        log.error('platform teardown step failed', e);
      }
    }
  };
}

export { platformHooks, installPlatformHooks, subscribeTasksChanged } from './hooks';
export type { PlatformHooks } from './hooks';
