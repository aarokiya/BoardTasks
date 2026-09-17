/**
 * Seam so platform code (tray, menu, notifications, global shortcut) can
 * summon windows without importing their modules. Filled in at startup.
 */
export interface WindowHooks {
  showMain(): void;
  focusTask(taskId: string): void;
  showQuickAdd(): void;
  toggleQuickAdd(): void;
  hideQuickAdd(): void;
}

export const windowHooks: WindowHooks = {
  showMain: () => {},
  focusTask: () => {},
  showQuickAdd: () => {},
  toggleQuickAdd: () => {},
  hideQuickAdd: () => {},
};

export function installWindowHooks(h: Partial<WindowHooks>): void {
  Object.assign(windowHooks, h);
}
