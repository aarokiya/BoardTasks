import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate, type MenuDeps } from '../../../../src/main/platform/menu-template';
import { COMMANDS } from '../../../../src/renderer/src/commands/ids';
import { DEFAULT_SETTINGS, type Settings } from '../../../../src/shared/models';

function deps(over: Partial<MenuDeps> = {}): MenuDeps {
  return {
    settings: DEFAULT_SETTINGS,
    isPackaged: false,
    quickAddAccelerator: 'Control+Shift+Space',
    runCommand: vi.fn(),
    showQuickAdd: vi.fn(),
    setTheme: vi.fn(),
    openDocs: vi.fn(),
    ...over,
  };
}

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    out.push(item);
    if (Array.isArray(item.submenu)) out.push(...flatten(item.submenu));
  }
  return out;
}

const topLabels = (t: MenuItemConstructorOptions[]): string[] => t.map((m) => String(m.label));

describe('buildMenuTemplate', () => {
  it('has the nine macOS top-level menus in order', () => {
    expect(topLabels(buildMenuTemplate(deps()))).toEqual(['BoardTasks', 'File', 'Edit', 'Task', 'View', 'Sync', 'GitHub', 'Window', 'Help']);
  });

  it('includes the Edit roles — without them clipboard is dead in every input', () => {
    const edit = buildMenuTemplate(deps()).find((m) => m.label === 'Edit');
    const roles = (edit?.submenu as MenuItemConstructorOptions[]).map((m) => m.role).filter(Boolean);
    expect(roles).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
  });

  it('represents every command group from the registry', () => {
    const ids = new Set(flatten(buildMenuTemplate(deps())).map((m) => m.id));
    const groups = new Set(COMMANDS.map((c) => c.group));
    for (const group of groups) {
      const inGroup = COMMANDS.filter((c) => c.group === group);
      expect(inGroup.some((c) => ids.has(c.id)), `group ${group} has no menu item`).toBe(true);
    }
  });

  it('converts glyph shortcuts into accelerators and leaves bare keys out', () => {
    const items = flatten(buildMenuTemplate(deps()));
    const newTask = items.find((m) => m.id === 'create.task');
    expect(newTask?.accelerator).toBe('CmdOrCtrl+N');
    const complete = items.find((m) => m.id === 'task.complete');
    expect(complete?.accelerator).toBeUndefined();
    expect(complete?.label).toBe('Complete (Space)');
  });

  it('routes command clicks through runCommand with the registry id', () => {
    const run = vi.fn();
    const items = flatten(buildMenuTemplate(deps({ runCommand: run })));
    const syncNow = items.find((m) => m.id === 'sync.now');
    expect(syncNow?.accelerator).toBe('CmdOrCtrl+R');
    syncNow?.click?.(undefined as never, undefined, undefined as never);
    expect(run).toHaveBeenCalledWith('sync.now');
  });

  it('shows the global Quick Add accelerator and calls the window seam directly', () => {
    const showQuickAdd = vi.fn();
    const items = flatten(buildMenuTemplate(deps({ showQuickAdd, quickAddAccelerator: 'Alt+Shift+A' })));
    const quickAdd = items.find((m) => m.id === 'create.quickadd');
    expect(quickAdd?.accelerator).toBe('Alt+Shift+A');
    quickAdd?.click?.(undefined as never, undefined, undefined as never);
    expect(showQuickAdd).toHaveBeenCalledTimes(1);
  });

  it('marks the theme radio matching the current setting', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, theme: 'dark' };
    const setTheme = vi.fn();
    const items = flatten(buildMenuTemplate(deps({ settings, setTheme })));
    const light = items.find((m) => m.id === 'view.theme.light');
    const dark = items.find((m) => m.id === 'view.theme.dark');
    expect([light?.type, light?.checked]).toEqual(['radio', false]);
    expect([dark?.type, dark?.checked]).toEqual(['radio', true]);
    light?.click?.(undefined as never, undefined, undefined as never);
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('reflects showCompletedInLists as a checkbox', () => {
    const items = flatten(buildMenuTemplate(deps({ settings: { ...DEFAULT_SETTINGS, showCompletedInLists: true } })));
    const item = items.find((m) => m.id === 'view.showCompleted');
    expect([item?.type, item?.checked]).toEqual(['checkbox', true]);
  });

  it('hides Reload / DevTools in a packaged build', () => {
    const dev = flatten(buildMenuTemplate(deps({ isPackaged: false }))).map((m) => m.role);
    const packaged = flatten(buildMenuTemplate(deps({ isPackaged: true }))).map((m) => m.role);
    expect(dev).toContain('toggleDevTools');
    expect(packaged).not.toContain('toggleDevTools');
    expect(packaged).not.toContain('reload');
  });

  it('opens the Google Cloud guide from Help', () => {
    const openDocs = vi.fn();
    const help = buildMenuTemplate(deps({ openDocs })).find((m) => m.label === 'Help');
    const guide = (help?.submenu as MenuItemConstructorOptions[]).find((m) => m.label === 'Google Cloud Setup Guide');
    guide?.click?.(undefined as never, undefined, undefined as never);
    expect(openDocs).toHaveBeenCalledTimes(1);
  });
});
