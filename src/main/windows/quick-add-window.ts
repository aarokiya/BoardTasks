import { BrowserWindow, app, nativeTheme, screen } from 'electron';
import { isE2E } from '../env';
import { openExternalChecked } from '../security/harden';
import { preloadPath } from '../paths';
import { getSettings } from '../db/repositories/settings';
import { emit } from '../ipc/emitter';
import { bootArgs, rendererUrl, THEME_BG } from './main-window';
import { installWindowHooks } from './hooks';

const WIDTH = 640;
export const MIN_HEIGHT = 60;
export const DEFAULT_HEIGHT = 92;
export const MAX_HEIGHT = 320;
/** Fraction of the display height the HUD's top edge sits at. */
const TOP_FRACTION = 0.28;
/** Clicking through to another app should dismiss — but not a click on our own chrome. */
const BLUR_GRACE_MS = 120;

let win: BrowserWindow | null = null;
let blurTimer: NodeJS.Timeout | null = null;

export const getQuickAddWindow = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null);

/** Top-left corner for the display the cursor is currently on. */
export function quickAddBounds(height = DEFAULT_HEIGHT): { x: number; y: number; width: number; height: number } {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const x = Math.round(area.x + (area.width - WIDTH) / 2);
  const y = Math.round(area.y + area.height * TOP_FRACTION);
  return { x, y, width: WIDTH, height };
}

export const clampHeight = (h: number): number => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h)));

function create(): BrowserWindow {
  const resolvedBg = THEME_BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
  const bounds = quickAddBounds();
  const next = new BrowserWindow({
    ...bounds,
    minWidth: WIDTH,
    maxWidth: WIDTH,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    show: false,
    frame: false,
    transparent: !isE2E,
    backgroundColor: isE2E ? resolvedBg : '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    acceptFirstMouse: true,
    title: 'Quick Add',
    // Vibrancy is a liability almost everywhere; the HUD is the exception.
    ...(isE2E ? {} : { vibrancy: 'hud' as const, visualEffectState: 'active' as const }),
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
      additionalArguments: bootArgs('quickadd', getSettings().theme),
    },
  });

  if (!isE2E) {
    next.setAlwaysOnTop(true, 'floating');
    next.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  next.on('blur', () => {
    if (isE2E) return;
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = null;
      const w = getQuickAddWindow();
      if (w && w.isVisible() && !w.isFocused()) w.hide();
    }, BLUR_GRACE_MS);
  });
  next.on('closed', () => {
    win = null;
  });
  // Same rule as the main window: never bypass the external-URL allowlist.
  next.webContents.setWindowOpenHandler(({ url }) => {
    openExternalChecked(url);
    return { action: 'deny' };
  });
  next.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('quick add failed to load', code, desc, url);
  });

  void next.loadURL(rendererUrl('quickadd'));
  win = next;
  return next;
}

/** Create the window if needed, but leave it hidden — makes the first ⌃⇧Space instant. */
export function ensureQuickAddWindow(): BrowserWindow {
  return getQuickAddWindow() ?? create();
}

export function showQuickAdd(): void {
  const w = ensureQuickAddWindow();
  if (blurTimer) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }
  const { x, y } = quickAddBounds();
  w.setBounds({ x, y, width: WIDTH, height: w.getBounds().height || DEFAULT_HEIGHT });
  w.show();
  w.focus();
  emit({ type: 'quickadd:shown' });
}

export function hideQuickAdd(): void {
  const w = getQuickAddWindow();
  if (w?.isVisible()) w.hide();
}

export function toggleQuickAdd(): void {
  const w = getQuickAddWindow();
  if (w?.isVisible()) hideQuickAdd();
  else showQuickAdd();
}

/** Animate to a new height, keeping the window pinned where the user sees it. */
export function resizeQuickAdd(height: number): void {
  const w = getQuickAddWindow();
  if (!w) return;
  const b = w.getBounds();
  const next = clampHeight(height);
  if (next === b.height) return;
  w.setBounds({ x: b.x, y: b.y, width: WIDTH, height: next }, !isE2E);
}

/**
 * Register the quick-add window with the platform seam. Call once from
 * bootstrap(), after createMainWindow().
 */
export function initQuickAddWindow(): void {
  installWindowHooks({ showQuickAdd, toggleQuickAdd, hideQuickAdd });
}
