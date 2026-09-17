import { app } from 'electron';
import type { Settings } from '@shared/models';
import { createLogger } from '../logger';
import { getSettings, onSettingsChanged, setSettings } from '../db/repositories/settings';

const log = createLogger('login-item');

export interface LoginItemDeps {
  getOpenAtLogin(): boolean;
  setOpenAtLogin(openAtLogin: boolean): void;
  readSettings(): Settings;
  writeSettings(patch: Partial<Settings>): void;
  onSettingsChanged(l: (s: Settings, changed: (keyof Settings)[]) => void): () => void;
}

/**
 * The OS is the source of truth on boot: the user can remove BoardTasks from
 * System Settings ▸ Login Items without the app running, and a stale `true` in
 * our DB would silently re-add it on the next settings write.
 */
export function reconcileLoginItem(deps: LoginItemDeps): void {
  const system = deps.getOpenAtLogin();
  const stored = deps.readSettings().startAtLogin;
  if (system !== stored) {
    log.info(`login item reconciled: system=${system} stored=${stored} → system wins`);
    deps.writeSettings({ startAtLogin: system });
  }
}

export function installLoginItem(deps: LoginItemDeps): () => void {
  reconcileLoginItem(deps);
  return deps.onSettingsChanged((s, changed) => {
    if (!changed.includes('startAtLogin')) return;
    if (s.startAtLogin === deps.getOpenAtLogin()) return;
    deps.setOpenAtLogin(s.startAtLogin);
    log.info(`login item set to ${s.startAtLogin}`);
  });
}

export function initLoginItem(): () => void {
  return installLoginItem({
    getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
    setOpenAtLogin: (openAtLogin) => {
      // `--hidden` is what bootstrap reads to start without showing a window.
      // (`openAsHidden` was removed in Electron 44 — macOS 13+ ignores it.)
      app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] });
    },
    readSettings: getSettings,
    writeSettings: (patch) => {
      setSettings(patch);
    },
    onSettingsChanged,
  });
}
