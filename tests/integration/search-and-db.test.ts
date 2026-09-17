import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { closeDatabase, getDb, openDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { createList } from '../../src/main/db/repositories/lists';
import { createTask, deleteTasks, searchTasks, updateTask } from '../../src/main/db/repositories/tasks';

describe('FTS search', () => {
  let listId: string;

  beforeEach(() => {
    openDatabase(':memory:');
    listId = createList({ title: 'Work' }).id;
  });
  afterEach(() => {
    closeDatabase();
  });

  const titles = (q: string, limit?: number): string[] => searchTasks(q, limit).map((t) => t.title).sort();

  it('matches by prefix on every term', () => {
    createTask({ title: 'Book flights to Lisbon', listId });
    createTask({ title: 'Booking reference', listId });
    createTask({ title: 'Unrelated', listId });

    expect(titles('boo')).toEqual(['Book flights to Lisbon', 'Booking reference']);
    expect(titles('book lis')).toEqual(['Book flights to Lisbon']);
  });

  it('searches notes as well as titles', () => {
    createTask({ title: 'Opaque', listId, notes: 'passport number' });
    expect(titles('passport')).toEqual(['Opaque']);
  });

  it('treats FTS operators as literal text instead of throwing', () => {
    createTask({ title: 'Ship OR bail', listId });
    createTask({ title: 'star * thing', listId });
    createTask({ title: 'quoted "phrase" here', listId });

    expect(titles('OR')).toEqual(['Ship OR bail']);
    expect(titles('"phrase"')).toEqual(['quoted "phrase" here']);
    expect(searchTasks('*')).toEqual([]);
    expect(searchTasks('"')).toEqual([]);
    expect(searchTasks('AND NOT NEAR')).toEqual([]);
  });

  it('handles unicode and very long input without throwing', () => {
    createTask({ title: 'café brûlée 日本語', listId });
    expect(titles('café')).toEqual(['café brûlée 日本語']);
    expect(titles('日本')).toEqual(['café brûlée 日本語']);
    expect(() => searchTasks('x'.repeat(5000))).not.toThrow();
  });

  it('excludes deleted tasks even when they would fill the result page', () => {
    for (let i = 0; i < 20; i++) {
      const t = createTask({ title: `Widget ${i}`, listId });
      deleteTasks([t.id]);
    }
    const live = createTask({ title: 'Widget live', listId });

    // The limit must be applied after the deleted filter, not before it.
    expect(searchTasks('widget', 5).map((t) => t.id)).toEqual([live.id]);
  });

  it('follows a rename', () => {
    const t = createTask({ title: 'Alpha', listId });
    updateTask({ id: t.id, patch: { title: 'Beta' } });
    expect(titles('alpha')).toEqual([]);
    expect(titles('beta')).toEqual(['Beta']);
  });
});

describe('database open and migrate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bt-db-'));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op on a database already at the current version', () => {
    const path = join(dir, 'app.db');
    const { db, recovered } = openDatabase(path);
    expect(recovered).toBe(false);
    createList({ title: 'Keep me' });
    const version = db.pragma('user_version', { simple: true });

    runMigrations(db, path);
    expect(db.pragma('user_version', { simple: true })).toBe(version);
    expect((db.prepare('SELECT COUNT(*) c FROM task_lists').get() as { c: number }).c).toBe(1);
  });

  it('moves a corrupt file aside and starts fresh instead of deleting it', () => {
    const path = join(dir, 'app.db');
    writeFileSync(path, 'this is definitely not a sqlite database'.repeat(50));

    const { recovered } = openDatabase(path);
    expect(recovered).toBe(true);

    // A working, migrated database is in place...
    createList({ title: 'Fresh start' });
    expect(getDb().prepare('SELECT COUNT(*) c FROM task_lists').all()).toHaveLength(1);

    // ...and the user's bytes are still on disk, renamed, never dropped.
    const aside = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!), 'utf8')).toContain('not a sqlite database');
  });
});
