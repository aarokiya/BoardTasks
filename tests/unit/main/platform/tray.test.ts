import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => {
  const state = {
    menus: [] as MenuItemConstructorOptions[][],
    tooltips: [] as string[],
    destroyed: 0,
    created: 0,
    quit: 0,
    templateImage: false,
  };
  class FakeTray {
    constructor() {
      state.created++;
    }
    setToolTip(t: string): void {
      state.tooltips.push(t);
    }
    setIgnoreDoubleClickEvents(): void {
      /* recorded implicitly: called in initTray */
    }
    setContextMenu(menu: unknown): void {
      state.menus.push(menu as MenuItemConstructorOptions[]);
    }
    destroy(): void {
      state.destroyed++;
    }
  }
  return { state, FakeTray };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/tmp', getPath: () => '/tmp', getVersion: () => '0', quit: () => mocks.state.quit++, on: () => {}, off: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
  Tray: mocks.FakeTray,
  // buildFromTemplate is identity so the template stays inspectable.
  Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => t, setApplicationMenu: () => {} },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => false,
      setTemplateImage: (v: boolean) => {
        mocks.state.templateImage = v;
      },
    }),
  },
}));

import { openDatabase, closeDatabase } from '../../../../src/main/db/connection';
import { createTask } from '../../../../src/main/db/repositories/tasks';
import { resetSettingsCache, setSettings } from '../../../../src/main/db/repositories/settings';
import { todayCivil } from '../../../../src/shared/date/civil';
import { addDays } from '../../../../src/shared/date/format';
import { buildTrayMenuTemplate, initTray } from '../../../../src/main/platform/tray';
import { installPlatformHooks, platformHooks, resetPlatformHooks } from '../../../../src/main/platform/hooks';
import { installWindowHooks } from '../../../../src/main/windows/hooks';

const labels = (menu: MenuItemConstructorOptions[]): string[] => menu.filter((m) => m.type !== 'separator').map((m) => String(m.label));
const click = (menu: MenuItemConstructorOptions[], label: string): void => {
  menu.find((m) => m.label === label)?.click?.(undefined as never, undefined, undefined as never);
};

beforeEach(() => {
  openDatabase(':memory:');
  resetSettingsCache();
  installWindowHooks({ showMain: () => {}, focusTask: () => {}, showQuickAdd: () => {}, toggleQuickAdd: () => {}, hideQuickAdd: () => {} });
  mocks.state.menus = [];
  mocks.state.tooltips = [];
  mocks.state.destroyed = 0;
  mocks.state.created = 0;
  mocks.state.quit = 0;
  resetPlatformHooks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  closeDatabase();
});

describe('buildTrayMenuTemplate', () => {
  it('lists the counts and the Quick Add accelerator', () => {
    const actions = { openMain: vi.fn(), quickAdd: vi.fn(), navigate: vi.fn(), syncNow: vi.fn(), openSettings: vi.fn(), quit: vi.fn() };
    const menu = buildTrayMenuTemplate({ today: 4, overdue: 1 }, 'Control+Shift+Space', actions);
    expect(labels(menu)).toEqual(['Open BoardTasks', 'Quick Add', 'Today (4)', 'Overdue (1)', 'Sync Now', 'Settings…', 'Quit BoardTasks']);
    expect(menu.find((m) => m.label === 'Quick Add')?.accelerator).toBe('Control+Shift+Space');
    click(menu, 'Today (4)');
    expect(actions.navigate).toHaveBeenCalledWith('today');
    click(menu, 'Overdue (1)');
    expect(actions.navigate).toHaveBeenCalledWith('overdue');
    click(menu, 'Sync Now');
    expect(actions.syncNow).toHaveBeenCalledTimes(1);
  });
});

describe('initTray', () => {
  it('builds a template image tray with counts from the database', () => {
    const today = todayCivil();
    createTask({ title: 'late', due: addDays(today, -2) });
    createTask({ title: 'now', due: today });
    createTask({ title: 'later', due: addDays(today, 3) });

    const dispose = initTray();
    expect(mocks.state.created).toBe(1);
    expect(mocks.state.tooltips).toEqual(['BoardTasks']);
    expect(mocks.state.templateImage).toBe(true);
    expect(labels(mocks.state.menus[0]!)).toContain('Today (2)');
    expect(labels(mocks.state.menus[0]!)).toContain('Overdue (1)');
    dispose();
  });

  it('refreshes on onTasksChanged, debounced', () => {
    createTask({ title: 'a', due: todayCivil() });
    const dispose = initTray();
    const initial = mocks.state.menus.length;

    createTask({ title: 'b', due: todayCivil() });
    platformHooks.onTasksChanged();
    platformHooks.onTasksChanged();
    platformHooks.onTasksChanged();
    expect(mocks.state.menus.length).toBe(initial);

    vi.advanceTimersByTime(100);
    expect(mocks.state.menus.length).toBe(initial + 1);
    expect(labels(mocks.state.menus.at(-1)!)).toContain('Today (2)');
    dispose();
  });

  it('honours showTrayIcon by destroying and recreating', () => {
    const dispose = initTray();
    expect(mocks.state.created).toBe(1);
    setSettings({ showTrayIcon: false });
    expect(mocks.state.destroyed).toBe(1);
    setSettings({ showTrayIcon: true });
    expect(mocks.state.created).toBe(2);
    dispose();
  });

  it('routes the menu through the window and platform seams', () => {
    const showMain = vi.fn();
    const showQuickAdd = vi.fn();
    const syncNow = vi.fn();
    installWindowHooks({ showMain, showQuickAdd });
    installPlatformHooks({ syncNow });
    const dispose = initTray();
    const menu = mocks.state.menus[0]!;

    click(menu, 'Open BoardTasks');
    expect(showMain).toHaveBeenCalledTimes(1);
    click(menu, 'Quick Add');
    expect(showQuickAdd).toHaveBeenCalledTimes(1);
    click(menu, 'Sync Now');
    expect(syncNow).toHaveBeenCalledTimes(1);
    // Settings and the smart views need a window before the event is useful.
    click(menu, 'Settings…');
    expect(showMain).toHaveBeenCalledTimes(2);
    click(menu, 'Quit BoardTasks');
    expect(mocks.state.quit).toBe(1);
    dispose();
  });
});
