import { app, BrowserWindow, Menu } from 'electron';
import type { ThemePreference } from '@shared/models';
import { createLogger } from '../logger';
import { getSettings, onSettingsChanged, setSettings } from '../db/repositories/settings';
import { openExternalChecked } from '../security/harden';
import { emit } from '../ipc/emitter';
import { windowHooks } from '../windows/hooks';
import { buildMenuTemplate } from './menu-template';

const log = createLogger('menu');

/** Linked from Help; the wizard walks through creating a Desktop OAuth client here. */
export const GOOGLE_TASKS_DOCS_URL = 'https://developers.google.com/workspace/tasks';

/**
 * Menu clicks become the same `shortcut` events the renderer's KeyboardScope
 * already dispatches, so a command has exactly one implementation. If every
 * window is hidden (tray mode) we surface one first — otherwise the event is
 * broadcast into the void.
 */
function runCommand(id: string): void {
  if (!BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible())) windowHooks.showMain();
  emit({ type: 'shortcut', command: id });
}

function setTheme(preference: ThemePreference): void {
  setSettings({ theme: preference });
}

export function rebuildAppMenu(): void {
  const settings = getSettings();
  const template = buildMenuTemplate({
    settings,
    isPackaged: app.isPackaged,
    quickAddAccelerator: settings.quickAddShortcut,
    runCommand,
    showQuickAdd: () => windowHooks.showQuickAdd(),
    setTheme,
    openDocs: () => {
      if (!openExternalChecked(GOOGLE_TASKS_DOCS_URL)) log.warn('docs url rejected by the external-url allowlist');
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Settings that are reflected *in* the menu; anything else needn't rebuild it. */
const MENU_RELEVANT = ['theme', 'quickAddShortcut', 'showCompletedInLists'] as const;

export function installAppMenu(): () => void {
  rebuildAppMenu();
  const off = onSettingsChanged((_s, changed) => {
    if (MENU_RELEVANT.some((k) => changed.includes(k))) rebuildAppMenu();
  });
  return off;
}
