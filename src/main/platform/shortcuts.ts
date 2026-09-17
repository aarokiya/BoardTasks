import { app, globalShortcut } from 'electron';
import { createLogger } from '../logger';
import { isE2E } from '../env';
import { getSettings, onSettingsChanged } from '../db/repositories/settings';
import { windowHooks } from '../windows/hooks';
import { emit } from '../ipc/emitter';
import { isValidAccelerator } from './accelerator';

const log = createLogger('shortcut');

let registered: string | null = null;

function unregister(): void {
  if (registered) {
    try {
      globalShortcut.unregister(registered);
    } catch (e) {
      log.warn('unregister failed', e);
    }
    registered = null;
  }
}

function failed(accel: string, why: string): void {
  log.warn(`global shortcut ${accel} unavailable: ${why}`);
  emit({
    type: 'toast',
    level: 'warn',
    message: `Quick Add shortcut ${accel} is used by another app. Pick a different one in Settings.`,
    actionLabel: 'Open Settings',
    actionCommand: 'app.settings',
  });
}

/** Registers the Quick Add accelerator. Returns true when the OS accepted it. */
export function registerQuickAddShortcut(accel: string): boolean {
  unregister();
  if (!isValidAccelerator(accel)) {
    failed(accel, 'not a valid accelerator');
    return false;
  }
  let ok: boolean;
  try {
    // register() throws on some malformed strings even after validation.
    ok = globalShortcut.register(accel, () => windowHooks.toggleQuickAdd());
  } catch (e) {
    log.warn('register threw', e);
    ok = false;
  }
  if (!ok || !globalShortcut.isRegistered(accel)) {
    failed(accel, ok ? 'claimed by another application' : 'registration refused');
    unregister();
    return false;
  }
  registered = accel;
  log.info(`global shortcut registered: ${accel}`);
  return true;
}

export function initGlobalShortcut(): () => void {
  // Playwright drives a real app but cannot press a system-wide hotkey, so E2E
  // gets a direct seam instead of a registration that would also collide with
  // the developer's own running copy.
  if (isE2E) {
    Object.assign(globalThis, { __btTriggerQuickAdd: () => windowHooks.toggleQuickAdd() });
    log.info('E2E: global shortcut skipped, __btTriggerQuickAdd installed');
    return () => {
      Reflect.deleteProperty(globalThis, '__btTriggerQuickAdd');
    };
  }

  registerQuickAddShortcut(getSettings().quickAddShortcut);

  const offSettings = onSettingsChanged((s, changed) => {
    if (changed.includes('quickAddShortcut')) registerQuickAddShortcut(s.quickAddShortcut);
  });
  const onWillQuit = (): void => globalShortcut.unregisterAll();
  app.on('will-quit', onWillQuit);

  return () => {
    offSettings();
    app.off('will-quit', onWillQuit);
    unregister();
  };
}
