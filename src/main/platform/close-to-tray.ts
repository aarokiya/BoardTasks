import { app, dialog, type BrowserWindow, type Event as ElectronEvent } from 'electron';
import { createLogger } from '../logger';
import { getSettings, setSettings } from '../db/repositories/settings';
import { getMainWindow, isQuitting } from '../windows/main-window';

const log = createLogger('close-to-tray');

export const CLOSE_TO_TRAY_MESSAGE = 'BoardTasks keeps running in the menu bar';
export const CLOSE_TO_TRAY_DETAIL = 'Reminders and sync keep working while the window is closed. Quit with ⌘Q.';

let dialogOpen = false;

/**
 * main-window.ts turns ⌘W into `hide()` when closeToTray is on. Without an
 * explanation the app looks like it refuses to quit, so the first hide gets one
 * — and only the first.
 */
async function explain(): Promise<void> {
  if (dialogOpen) return;
  dialogOpen = true;
  try {
    const res = await dialog.showMessageBox({
      type: 'info',
      message: CLOSE_TO_TRAY_MESSAGE,
      detail: CLOSE_TO_TRAY_DETAIL,
      buttons: ['Keep running', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      checkboxLabel: "Don't show this again",
      // Checked by default: the normal path is a one-time explanation. Leaving
      // it unchecked is an explicit "remind me next time".
      checkboxChecked: true,
    });
    setSettings({ closeToTrayExplained: res.checkboxChecked });
    if (res.response === 1) app.quit();
  } catch (e) {
    log.error('close-to-tray dialog failed', e);
  } finally {
    dialogOpen = false;
  }
}

export function initCloseToTray(): () => void {
  const attached = new WeakSet<BrowserWindow>();

  const onHide = (): void => {
    if (isQuitting()) return;
    const s = getSettings();
    if (!s.closeToTray || s.closeToTrayExplained) return;
    void explain();
  };

  const attach = (win: BrowserWindow | null): void => {
    if (!win || attached.has(win)) return;
    attached.add(win);
    win.on('hide', onHide);
  };

  attach(getMainWindow());

  // A window created later (the `activate` handler recreates it after a real
  // close) must be hooked too. `browser-window-created` fires inside the
  // BrowserWindow constructor, before main-window.ts has assigned its module
  // variable — hence the microtask.
  const onCreated = (_e: ElectronEvent, win: BrowserWindow): void => {
    queueMicrotask(() => {
      if (win === getMainWindow()) attach(win);
    });
  };
  app.on('browser-window-created', onCreated);

  return () => {
    app.off('browser-window-created', onCreated);
    getMainWindow()?.off('hide', onHide);
  };
}
