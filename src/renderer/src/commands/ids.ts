/**
 * Every command the app exposes: single source of truth for the palette,
 * keyboard shortcuts, the cheat sheet, and the native menu. Shortcut strings
 * use macOS glyphs for display; the dispatcher parses them.
 */
export interface CommandMeta {
  id: string;
  label: string;
  group: 'Task' | 'Create' | 'Navigate' | 'View' | 'Sync' | 'GitHub' | 'App' | 'Edit';
  shortcut?: string;
  keywords?: string[];
  destructive?: boolean;
}

export const COMMANDS = [
  { id: 'create.task', label: 'New Task', group: 'Create', shortcut: '⌘N' },
  { id: 'create.subtask', label: 'New Subtask', group: 'Create', shortcut: '⌘⇧N' },
  { id: 'create.list', label: 'New List', group: 'Create', shortcut: '⌘⇧L' },
  { id: 'create.quickadd', label: 'Quick Add (Global)', group: 'Create', shortcut: '⌃⇧Space' },
  { id: 'task.complete', label: 'Complete', group: 'Task', shortcut: 'Space', keywords: ['done', 'finish', 'check'] },
  { id: 'task.rename', label: 'Rename', group: 'Task', shortcut: 'E', keywords: ['edit', 'title'] },
  { id: 'task.delete', label: 'Delete', group: 'Task', shortcut: '⌘⌫', destructive: true, keywords: ['remove', 'trash'] },
  { id: 'task.due.today', label: 'Due Today', group: 'Task', shortcut: 'T' },
  { id: 'task.due.tomorrow', label: 'Due Tomorrow', group: 'Task', shortcut: '⇧T' },
  { id: 'task.due.weekend', label: 'Due This Weekend', group: 'Task' },
  { id: 'task.due.nextweek', label: 'Due Next Week', group: 'Task' },
  { id: 'task.due.pick', label: 'Set Due Date…', group: 'Task', shortcut: 'D', keywords: ['schedule', 'date', 'when'] },
  { id: 'task.due.clear', label: 'Clear Due Date', group: 'Task', shortcut: '⇧D' },
  { id: 'task.time.pick', label: 'Set Reminder Time…', group: 'Task', shortcut: 'R', keywords: ['remind', 'notification', 'alarm'] },
  { id: 'task.priority.1', label: 'Priority: High', group: 'Task', shortcut: '1' },
  { id: 'task.priority.2', label: 'Priority: Medium', group: 'Task', shortcut: '2' },
  { id: 'task.priority.3', label: 'Priority: Low', group: 'Task', shortcut: '3' },
  { id: 'task.priority.0', label: 'Priority: None', group: 'Task', shortcut: '0' },
  { id: 'task.flag', label: 'Toggle Flag', group: 'Task', shortcut: 'F', keywords: ['star', 'important'] },
  { id: 'task.move', label: 'Move to List…', group: 'Task', shortcut: '⌘⇧M' },
  { id: 'task.indent', label: 'Indent', group: 'Task', shortcut: 'Tab', keywords: ['nest', 'subtask'] },
  { id: 'task.outdent', label: 'Outdent', group: 'Task', shortcut: '⇧Tab' },
  { id: 'task.moveUp', label: 'Move Up', group: 'Task', shortcut: '⌥↑' },
  { id: 'task.moveDown', label: 'Move Down', group: 'Task', shortcut: '⌥↓' },
  { id: 'task.duplicate', label: 'Duplicate', group: 'Task', shortcut: '⌘D' },
  { id: 'task.copyLink', label: 'Copy Google Tasks Link', group: 'Task' },
  { id: 'task.openInGoogle', label: 'Open in Google Tasks', group: 'Task' },
  { id: 'task.expand', label: 'Expand / Collapse Subtasks', group: 'Task', shortcut: '⌘.' },
  { id: 'edit.undo', label: 'Undo', group: 'Edit', shortcut: '⌘Z' },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', shortcut: '⌘⇧Z' },
  { id: 'edit.selectAll', label: 'Select All', group: 'Edit', shortcut: '⌘A' },
  { id: 'edit.find', label: 'Filter Tasks', group: 'Edit', shortcut: '⌘F', keywords: ['search'] },
  { id: 'nav.today', label: 'Go to Today', group: 'Navigate', shortcut: '⌘1' },
  { id: 'nav.upcoming', label: 'Go to Upcoming', group: 'Navigate', shortcut: '⌘2' },
  { id: 'nav.overdue', label: 'Go to Overdue', group: 'Navigate', shortcut: '⌘3' },
  { id: 'nav.all', label: 'Go to All Tasks', group: 'Navigate', shortcut: '⌘4' },
  { id: 'nav.nodate', label: 'Go to No Date', group: 'Navigate', shortcut: '⌘5' },
  { id: 'nav.github', label: 'Go to GitHub', group: 'Navigate', shortcut: '⌘6' },
  { id: 'nav.completed', label: 'Go to Completed', group: 'Navigate', shortcut: '⌘7' },
  { id: 'nav.list', label: 'Go to List…', group: 'Navigate', shortcut: '⌘G' },
  { id: 'nav.next', label: 'Next Task', group: 'Navigate', shortcut: 'J' },
  { id: 'nav.prev', label: 'Previous Task', group: 'Navigate', shortcut: 'K' },
  { id: 'view.palette', label: 'Command Palette', group: 'View', shortcut: '⌘K' },
  { id: 'view.shortcuts', label: 'Keyboard Shortcuts', group: 'View', shortcut: '⌘/' },
  { id: 'view.sidebar', label: 'Toggle Sidebar', group: 'View', shortcut: '⌘\\' },
  { id: 'view.inspector', label: 'Toggle Inspector', group: 'View', shortcut: '⌘I' },
  { id: 'view.showCompleted', label: 'Show / Hide Completed', group: 'View', shortcut: '⌘⇧H' },
  { id: 'view.density', label: 'Cycle Density', group: 'View' },
  { id: 'view.theme.light', label: 'Theme: Light', group: 'View' },
  { id: 'view.theme.dark', label: 'Theme: Dark', group: 'View' },
  { id: 'view.theme.system', label: 'Theme: Follow System', group: 'View' },
  { id: 'view.zoomIn', label: 'Zoom In', group: 'View', shortcut: '⌘=' },
  { id: 'view.zoomOut', label: 'Zoom Out', group: 'View', shortcut: '⌘-' },
  { id: 'view.zoomReset', label: 'Actual Size', group: 'View', shortcut: '⌘0' },
  { id: 'sync.now', label: 'Sync Now', group: 'Sync', shortcut: '⌘R', keywords: ['refresh'] },
  { id: 'sync.full', label: 'Full Resync', group: 'Sync' },
  { id: 'sync.outbox', label: 'Review Unsynced Changes', group: 'Sync', keywords: ['failed', 'pending', 'outbox'] },
  { id: 'github.link', label: 'Link GitHub Issue or PR…', group: 'GitHub', shortcut: '⌘⇧G' },
  { id: 'github.unlink', label: 'Remove GitHub Link', group: 'GitHub' },
  { id: 'github.open', label: 'Open on GitHub', group: 'GitHub', shortcut: '⌘⇧O' },
  { id: 'github.refresh', label: 'Refresh GitHub Status', group: 'GitHub' },
  { id: 'app.settings', label: 'Settings…', group: 'App', shortcut: '⌘,' },
  { id: 'app.signOut', label: 'Sign Out of Google', group: 'App' },
  { id: 'app.revealLogs', label: 'Reveal Log File', group: 'App' },
] as const satisfies readonly CommandMeta[];

export type CommandId = (typeof COMMANDS)[number]['id'];
export const commandMeta = (id: CommandId): CommandMeta => COMMANDS.find((c) => c.id === id)!;
