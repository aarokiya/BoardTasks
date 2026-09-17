import { app, powerMonitor, type BrowserWindow, type Event as ElectronEvent } from 'electron';
import { createLogger } from '../logger';
import { emit } from '../ipc/emitter';
import { getMainWindow } from '../windows/main-window';
import { emitResume, emitSuspend } from './hooks';

const log = createLogger('power');

/**
 * Waking is not the same as being online: the Wi-Fi interface takes a moment to
 * associate, and a request issued at t+0 fails with a misleading network error.
 * Everything that reacts to resume goes through this delay.
 */
export const RESUME_DELAY_MS = 3000;

export function initPowerMonitor(): () => void {
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;

  const onResume = (): void => {
    log.info('system resumed');
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      emit({ type: 'system:resume' });
      emitResume();
    }, RESUME_DELAY_MS);
    resumeTimer.unref?.();
  };

  const onSuspend = (): void => {
    log.info('system suspending');
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    emitSuspend();
  };

  powerMonitor.on('resume', onResume);
  powerMonitor.on('suspend', onSuspend);

  // Subscribed on the app rather than the window object so a window recreated
  // by the `activate` handler keeps reporting focus.
  const onFocus = (_e: ElectronEvent, win: BrowserWindow): void => {
    if (win === getMainWindow()) emit({ type: 'window:focus', focused: true });
  };
  const onBlur = (_e: ElectronEvent, win: BrowserWindow): void => {
    if (win === getMainWindow()) emit({ type: 'window:focus', focused: false });
  };
  app.on('browser-window-focus', onFocus);
  app.on('browser-window-blur', onBlur);

  return () => {
    powerMonitor.off('resume', onResume);
    powerMonitor.off('suspend', onSuspend);
    app.off('browser-window-focus', onFocus);
    app.off('browser-window-blur', onBlur);
    if (resumeTimer) clearTimeout(resumeTimer);
  };
}
