/**
 * wipe.ts is owned by the auth track (it is what "Sign out and delete local
 * data" calls), so its test lives beside the rest of the auth suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ emit: vi.fn(), emitDataChanged: vi.fn() }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
}));
vi.mock('../../../../src/main/ipc/emitter', () => ({ emit: h.emit, emitDataChanged: h.emitDataChanged, flushEmitter: vi.fn() }));

import { closeDatabase, getDb, openDatabase } from '../../../../src/main/db/connection';
import { createList, getAllLists } from '../../../../src/main/db/repositories/lists';
import { createTask, searchTasks } from '../../../../src/main/db/repositories/tasks';
import { listOutbox } from '../../../../src/main/db/repositories/outbox';
import { getSettings, resetSettingsCache, setSettings } from '../../../../src/main/db/repositories/settings';
import { wipeLocalData } from '../../../../src/main/db/wipe';

const count = (table: string): number => (getDb().prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

beforeEach(() => {
  h.emit.mockReset();
  h.emitDataChanged.mockReset();
  resetSettingsCache();
  openDatabase(':memory:');
});

afterEach(() => {
  closeDatabase();
  resetSettingsCache();
});

describe('wipeLocalData', () => {
  it('empties every account-data table and reports the ids it removed', () => {
    const list = createList({ title: 'Work', color: 'blue' });
    const a = createTask({ title: 'Ship the release', listId: list.id });
    const b = createTask({ title: 'Buy milk', listId: list.id });
    getDb().prepare(`INSERT INTO trash (task_id, snapshot, deleted_at) VALUES (?, '{}', '2026-01-01T00:00:00.000Z')`).run(a.id);
    getDb().prepare(`INSERT INTO notifications_sent (task_id, fire_at, sent_at) VALUES (?, 'x', 'y')`).run(b.id);
    getDb()
      .prepare(`INSERT INTO sync_state (scope, watermark, consecutive_errors, server_skew_ms, updated_at) VALUES ('global', 'w', 0, 0, 'now')`)
      .run();
    expect(listOutbox().length).toBeGreaterThan(0);

    const result = wipeLocalData();

    expect(result.deletedTaskIds.sort()).toEqual([a.id, b.id].sort());
    expect(result.deletedListIds).toEqual([list.id]);
    for (const table of ['tasks', 'task_lists', 'outbox', 'sync_state', 'github_links', 'trash', 'notifications_sent']) {
      expect(count(table)).toBe(0);
    }
    expect(getAllLists()).toEqual([]);
    // The FTS shadow table must go with the rows, or search would return ghosts.
    expect(searchTasks('release')).toEqual([]);
    expect(count('tasks_fts')).toBe(0);
  });

  it('emits one data:changed carrying only ids', () => {
    const list = createList({ title: 'L' });
    const t = createTask({ title: 'T', listId: list.id });
    wipeLocalData();
    expect(h.emitDataChanged).toHaveBeenCalledTimes(1);
    expect(h.emitDataChanged).toHaveBeenCalledWith({ reason: 'local', deletedTaskIds: [t.id], deletedListIds: [list.id] });
  });

  it('clears a defaultListId that would now point at a deleted list', () => {
    const list = createList({ title: 'L' });
    setSettings({ defaultListId: list.id });
    wipeLocalData();
    expect(getSettings().defaultListId).toBeNull();
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings:changed' }));
  });

  it('leaves app preferences alone', () => {
    setSettings({ theme: 'dark', quickAddShortcut: 'Control+Alt+Space' });
    wipeLocalData();
    expect(getSettings().theme).toBe('dark');
    expect(getSettings().quickAddShortcut).toBe('Control+Alt+Space');
  });

  it('is safe to run on an already-empty database', () => {
    expect(() => wipeLocalData()).not.toThrow();
    expect(h.emitDataChanged).toHaveBeenCalledWith({ reason: 'local', deletedTaskIds: [], deletedListIds: [] });
  });
});
