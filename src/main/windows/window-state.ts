import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite } from '../util/atomic-write';

export interface WindowState extends Rectangle {
  isMaximized: boolean;
  isFullScreen: boolean;
}

export const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1180, height: 760 };

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function loadWindowState(path: string): WindowState {
  let saved: Partial<WindowState> = {};
  try {
    if (existsSync(path)) saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowState>;
  } catch {
    /* corrupt → defaults */
  }
  const primary = screen.getPrimaryDisplay().workArea;
  const bounds: Rectangle = {
    x: typeof saved.x === 'number' ? saved.x : Math.round(primary.x + (primary.width - DEFAULT_BOUNDS.width) / 2),
    y: typeof saved.y === 'number' ? saved.y : Math.round(primary.y + (primary.height - DEFAULT_BOUNDS.height) / 2),
    width: Math.max(560, typeof saved.width === 'number' ? saved.width : DEFAULT_BOUNDS.width),
    height: Math.max(420, typeof saved.height === 'number' ? saved.height : DEFAULT_BOUNDS.height),
  };
  // Monitor unplugged → don't open offscreen.
  const visible = screen.getAllDisplays().some((d) => intersects(d.workArea, bounds));
  const safe = visible
    ? bounds
    : { ...bounds, x: Math.round(primary.x + (primary.width - bounds.width) / 2), y: Math.round(primary.y + (primary.height - bounds.height) / 2) };
  return { ...safe, isMaximized: saved.isMaximized === true, isFullScreen: saved.isFullScreen === true };
}

export function trackWindowState(win: BrowserWindow, path: string): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (win.isDestroyed()) return;
    const normal = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    const state: WindowState = { ...normal, isMaximized: win.isMaximized(), isFullScreen: win.isFullScreen() };
    try {
      atomicWrite(path, JSON.stringify(state), 0o644);
    } catch {
      /* best effort */
    }
  };
  const debounced = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('close', save);
}
