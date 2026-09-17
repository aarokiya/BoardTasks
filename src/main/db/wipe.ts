import { createLogger } from '../logger';
import { emit, emitDataChanged } from '../ipc/emitter';
import { getDb } from './connection';
import { getSettings, setSettings } from './repositories/settings';

const log = createLogger('db');

/**
 * Order matters: github_links and tasks hang off tasks/task_lists by foreign
 * key, so children go first even though the schema cascades. `settings` is
 * deliberately NOT wiped — theme, shortcut and density are the user's app
 * preferences, not their Google data.
 */
const TABLES = ['github_links', 'notifications_sent', 'trash', 'outbox', 'sync_state', 'tasks', 'task_lists'] as const;

export interface WipeResult {
  deletedTaskIds: string[];
  deletedListIds: string[];
}

/**
 * Removes every trace of the signed-in account's data from the local database.
 * Used by "Sign out and delete local data" — the one path where losing unsynced
 * outbox entries is the explicit intent rather than a bug.
 */
export function wipeLocalData(): WipeResult {
  const db = getDb();
  const deletedTaskIds = (db.prepare('SELECT id FROM tasks').all() as { id: string }[]).map((r) => r.id);
  const deletedListIds = (db.prepare('SELECT id FROM task_lists').all() as { id: string }[]).map((r) => r.id);

  db.transaction(() => {
    for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
  })();
  // The FTS index is content-synced by the AFTER DELETE trigger on tasks, but
  // an explicit rebuild costs nothing on an empty table and leaves no orphans.
  db.prepare(`INSERT INTO tasks_fts(tasks_fts) VALUES ('rebuild')`).run();

  // A defaultListId pointing at a list that no longer exists would make the
  // sidebar select a ghost, so clear it along with the lists it referenced.
  if (getSettings().defaultListId !== null) {
    emit({ type: 'settings:changed', settings: setSettings({ defaultListId: null }) });
  }

  log.warn(`local data wiped: ${deletedTaskIds.length} tasks, ${deletedListIds.length} lists`);
  emitDataChanged({ reason: 'local', deletedTaskIds, deletedListIds });
  return { deletedTaskIds, deletedListIds };
}
