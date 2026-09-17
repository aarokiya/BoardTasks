/**
 * The native menu is generated from the command registry — the same list the
 * palette, the cheat sheet and the keyboard scope use — so a command can never
 * exist in one surface and be missing from another.
 *
 * Pure: no electron import at runtime, every side effect arrives through `deps`.
 */
import type { MenuItemConstructorOptions } from 'electron';
// Relative, not '@/…': the main bundle has no '@' alias, and the command
// registry is deliberately dependency-free so both processes can own it.
import { COMMANDS, type CommandMeta } from '../../renderer/src/commands/ids';
import type { Settings, ThemePreference } from '@shared/models';
import { labelWithHint, toAccelerator } from './accelerator';

export interface MenuDeps {
  settings: Settings;
  /** Dev-only items (Reload, Toggle DevTools) are omitted from a packaged build. */
  isPackaged: boolean;
  /** Accelerator shown next to File ▸ Quick Add (the real registration is global). */
  quickAddAccelerator: string;
  runCommand(id: string): void;
  showQuickAdd(): void;
  setTheme(pref: ThemePreference): void;
  openDocs(): void;
}

const byId = new Map<string, CommandMeta>(COMMANDS.map((c) => [c.id, c]));

function meta(id: string): CommandMeta {
  const m = byId.get(id);
  // A typo here is a startup crash rather than a silently missing menu item.
  if (!m) throw new Error(`Unknown command id in menu template: ${id}`);
  return m;
}

/** Menu item for a registry command; falls back to a label hint when the shortcut can't be an accelerator. */
function cmd(id: string, deps: MenuDeps, overrides: MenuItemConstructorOptions = {}): MenuItemConstructorOptions {
  const m = meta(id);
  const accelerator = toAccelerator(m.shortcut);
  const item: MenuItemConstructorOptions = {
    id: m.id,
    label: labelWithHint(m.label, m.shortcut),
    click: () => deps.runCommand(m.id),
    ...overrides,
  };
  if (accelerator) item.accelerator = accelerator;
  return item;
}

const sep: MenuItemConstructorOptions = { type: 'separator' };

export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const appMenu: MenuItemConstructorOptions = {
    label: 'BoardTasks',
    submenu: [
      { role: 'about' },
      sep,
      cmd('app.settings', deps),
      cmd('app.signOut', deps),
      sep,
      { role: 'services', submenu: [] },
      sep,
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      sep,
      { role: 'quit' },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      cmd('create.task', deps),
      cmd('create.subtask', deps),
      cmd('create.list', deps),
      sep,
      { id: 'create.quickadd', label: 'Quick Add', accelerator: deps.quickAddAccelerator, click: () => deps.showQuickAdd() },
      sep,
      { role: 'close' },
    ],
  };

  // The Edit roles are mandatory: without them ⌘X/⌘C/⌘V do nothing inside every
  // text field in the app. This is the single most common Electron menu bug.
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      sep,
      cmd('edit.find', deps),
    ],
  };

  const taskMenu: MenuItemConstructorOptions = {
    label: 'Task',
    submenu: [
      cmd('task.complete', deps),
      cmd('task.rename', deps),
      sep,
      cmd('task.due.today', deps),
      cmd('task.due.tomorrow', deps),
      cmd('task.due.weekend', deps),
      cmd('task.due.nextweek', deps),
      cmd('task.due.pick', deps),
      cmd('task.due.clear', deps),
      cmd('task.time.pick', deps),
      sep,
      {
        label: 'Priority',
        submenu: [cmd('task.priority.1', deps), cmd('task.priority.2', deps), cmd('task.priority.3', deps), sep, cmd('task.priority.0', deps)],
      },
      cmd('task.flag', deps),
      sep,
      cmd('task.move', deps),
      cmd('task.indent', deps),
      cmd('task.outdent', deps),
      cmd('task.moveUp', deps),
      cmd('task.moveDown', deps),
      sep,
      cmd('task.duplicate', deps),
      cmd('task.expand', deps),
      cmd('task.copyLink', deps),
      cmd('task.openInGoogle', deps),
      sep,
      cmd('task.delete', deps),
    ],
  };

  const themeItem = (id: string, pref: ThemePreference): MenuItemConstructorOptions => ({
    id,
    label: meta(id).label,
    type: 'radio',
    checked: deps.settings.theme === pref,
    click: () => deps.setTheme(pref),
  });

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      cmd('nav.today', deps),
      cmd('nav.upcoming', deps),
      cmd('nav.overdue', deps),
      cmd('nav.all', deps),
      cmd('nav.nodate', deps),
      cmd('nav.github', deps),
      cmd('nav.completed', deps),
      sep,
      cmd('nav.list', deps),
      cmd('view.palette', deps),
      sep,
      cmd('view.sidebar', deps),
      cmd('view.inspector', deps),
      { ...cmd('view.showCompleted', deps), type: 'checkbox', checked: deps.settings.showCompletedInLists },
      cmd('view.density', deps),
      sep,
      { label: 'Theme', submenu: [themeItem('view.theme.light', 'light'), themeItem('view.theme.dark', 'dark'), themeItem('view.theme.system', 'system')] },
      sep,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { role: 'togglefullscreen' },
      ...(deps.isPackaged ? [] : [sep, { role: 'reload' } as MenuItemConstructorOptions, { role: 'toggleDevTools' } as MenuItemConstructorOptions]),
    ],
  };

  const syncMenu: MenuItemConstructorOptions = {
    label: 'Sync',
    submenu: [cmd('sync.now', deps), cmd('sync.full', deps), sep, cmd('sync.outbox', deps)],
  };

  const githubMenu: MenuItemConstructorOptions = {
    label: 'GitHub',
    submenu: [cmd('github.link', deps), cmd('github.unlink', deps), sep, cmd('github.open', deps), cmd('github.refresh', deps)],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'windowMenu',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, sep, { role: 'front' }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [cmd('view.shortcuts', deps), { label: 'Google Cloud Setup Guide', click: () => deps.openDocs() }, sep, cmd('app.revealLogs', deps)],
  };

  return [appMenu, fileMenu, editMenu, taskMenu, viewMenu, syncMenu, githubMenu, windowMenu, helpMenu];
}
