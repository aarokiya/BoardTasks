import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { join } from 'node:path';
import { todayCivil } from '@shared/date/civil';
import { createLogger } from '../logger';
import { resourcesDir } from '../paths';
import { countDue } from '../db/repositories/tasks';
import { getSettings, onSettingsChanged } from '../db/repositories/settings';
import { windowHooks } from '../windows/hooks';
import { emit } from '../ipc/emitter';
import { platformHooks, subscribeTasksChanged } from './hooks';

const log = createLogger('tray');

export interface TrayCounts {
  today: number;
  overdue: number;
}

export interface TrayActions {
  openMain(): void;
  quickAdd(): void;
  navigate(view: 'today' | 'overdue'): void;
  syncNow(): void;
  openSettings(): void;
  quit(): void;
}

/**
 * Pure template builder so the labels (and therefore the counts) are testable
 * without a running Electron app.
 */
export function buildTrayMenuTemplate(counts: TrayCounts, quickAddAccelerator: string, actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    { label: 'Open BoardTasks', click: () => actions.openMain() },
    { label: 'Quick Add', accelerator: quickAddAccelerator, click: () => actions.quickAdd() },
    { type: 'separator' },
    { label: `Today (${counts.today})`, click: () => actions.navigate('today') },
    { label: `Overdue (${counts.overdue})`, click: () => actions.navigate('overdue') },
    { type: 'separator' },
    { label: 'Sync Now', click: () => actions.syncNow() },
    { label: 'Settings…', click: () => actions.openSettings() },
    { type: 'separator' },
    { label: 'Quit BoardTasks', accelerator: 'Command+Q', click: () => actions.quit() },
  ];
}

const trayActions: TrayActions = {
  openMain: () => windowHooks.showMain(),
  quickAdd: () => windowHooks.showQuickAdd(),
  navigate: (view) => {
    windowHooks.showMain();
    emit({ type: 'navigate', view });
  },
  // The tray must work with no window open, so "Sync Now" goes through a
  // main-side seam rather than a renderer-dispatched shortcut event.
  syncNow: () => {
    if (platformHooks.syncNow) platformHooks.syncNow();
    else log.warn('Sync Now clicked but no syncNow hook is installed');
  },
  openSettings: () => {
    windowHooks.showMain();
    emit({ type: 'shortcut', command: 'app.settings' });
  },
  quit: () => app.quit(),
};

let tray: Tray | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function trayImage(): NativeImage {
  const path = join(resourcesDir(), 'icons', 'trayTemplate.png');
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) log.error(`tray icon missing or unreadable at ${path}`);
  // Template images are black+alpha; macOS recolors them for light/dark menu bars.
  img.setTemplateImage(true);
  return img;
}

function applyMenu(): void {
  if (!tray) return;
  const counts = countDue(todayCivil());
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(counts, getSettings().quickAddShortcut, trayActions)));
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip('BoardTasks');
  // Without this a fast second click is delivered as a double-click and the
  // menu flickers shut.
  tray.setIgnoreDoubleClickEvents(true);
  applyMenu();
  log.info('tray created');
}

function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
  log.info('tray destroyed');
}

/** Debounced: a bulk sync can call onTasksChanged hundreds of times in a burst. */
export function refreshTray(): void {
  if (!tray || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    try {
      applyMenu();
    } catch (e) {
      log.error('tray refresh failed', e);
    }
  }, 100);
  refreshTimer.unref?.();
}

export function initTray(): () => void {
  const sync = (): void => {
    if (getSettings().showTrayIcon) createTray();
    else destroyTray();
  };
  sync();

  const offSettings = onSettingsChanged((_s, changed) => {
    if (changed.includes('showTrayIcon')) sync();
    if (changed.includes('quickAddShortcut')) applyMenu();
  });
  const offTasks = subscribeTasksChanged(refreshTray);

  return () => {
    offSettings();
    offTasks();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    destroyTray();
  };
}
