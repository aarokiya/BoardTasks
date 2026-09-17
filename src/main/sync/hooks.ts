/**
 * Integration seam between the local data layer and the sync engine.
 * The sync track replaces these no-op defaults via `installSyncHooks` at startup,
 * so routes never import the engine directly.
 */
export interface SyncHooks {
  /** A local mutation was written to the outbox: debounce a push. */
  onLocalEdit(): void;
  /** Tasks changed (any reason): re-arm reminders, badges, tray counts. */
  onTasksChanged(): void;
}

export const syncHooks: SyncHooks = {
  onLocalEdit: () => {},
  onTasksChanged: () => {},
};

export function installSyncHooks(h: Partial<SyncHooks>): void {
  Object.assign(syncHooks, h);
}
