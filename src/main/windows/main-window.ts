import { BrowserWindow, app, nativeTheme } from 'electron';
import { APP_ORIGIN } from '@shared/constants';
import type { ThemePreference } from '@shared/models';
import { isE2E } from '../env';
import { openExternalChecked } from '../security/harden';
import { preloadPath } from '../paths';
import { loadWindowState, trackWindowState } from './window-state';

let mainWindow: BrowserWindow | null = null;
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});

export const isQuitting = (): boolean => quitting;
export const getMainWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

export const THEME_BG = { light: '#ececf0', dark: '#141417' } as const;

export function rendererUrl(hash = ''): string {
  const dev = process.env['ELECTRON_RENDERER_URL'];
  const base = dev && !app.isPackaged ? dev : `${APP_ORIGIN}/index.html`;
  return hash ? `${base}#${hash}` : base;
}

export function bootArgs(window: 'main' | 'quickadd', pref: ThemePreference): string[] {
  const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return [`--bt-window=${window}`, `--bt-theme=${resolved}`, `--bt-theme-pref=${pref}`, `--bt-e2e=${isE2E ? '1' : '0'}`];
}

export function createMainWindow(opts: { statePath: string; themePreference: ThemePreference; closeToTray: () => boolean; showOnCreate: boolean; translucent: boolean }): BrowserWindow {
  const existing = getMainWindow();
  if (existing) return existing;
  const state = loadWindowState(opts.statePath);
  const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: 'BoardTasks',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: THEME_BG[resolved],
    ...(opts.translucent ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const } : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: true,
      devTools: !app.isPackaged,
      additionalArguments: bootArgs('main', opts.themePreference),
    },
  });
  mainWindow = win;

  if (state.isMaximized) win.maximize();
  win.once('ready-to-show', () => {
    if (opts.showOnCreate) win.show();
    if (state.isFullScreen) win.setFullScreen(true);
  });
  trackWindowState(win, opts.statePath);

  win.on('close', (e) => {
    if (!quitting && opts.closeToTray()) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('renderer failed to load', code, desc, url);
  });
  // Always through the allowlist: a bare shell.openExternal() here would
  // override the hardened global handler and hand the renderer an arbitrary
  // `window.open()` → system URL handler primitive (file://, x-apple.*, …).
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalChecked(url);
    return { action: 'deny' };
  });

  void win.loadURL(rendererUrl());
  return win;
}

export function showMainWindow(): BrowserWindow | null {
  const win = getMainWindow();
  if (!win) return null;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  if (process.platform === 'darwin') void app.dock?.show();
  return win;
}
