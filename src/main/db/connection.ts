import Database from 'better-sqlite3';
import { existsSync, renameSync } from 'node:fs';
import { createLogger } from '../logger';
import { runMigrations } from './migrate';

const log = createLogger('db');

export type Db = Database.Database;

let db: Db | null = null;

function open(path: string): Db {
  const d = new Database(path);
  d.pragma('journal_mode = WAL');
  d.pragma('synchronous = NORMAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  d.pragma('temp_store = MEMORY');
  return d;
}

/**
 * Opens (or creates) the database. On corruption, the file is moved aside —
 * never silently deleted — and a fresh DB is created; the caller forces a full resync.
 */
export function openDatabase(path: string): { db: Db; recovered: boolean } {
  let recovered = false;
  try {
    db = open(path);
    db.pragma('quick_check');
    runMigrations(db, path);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    log.error('open failed', code, e);
    if (path !== ':memory:' && existsSync(path) && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')) {
      const aside = `${path}.corrupt-${Date.now()}`;
      try { db?.close(); } catch { /* ignore */ }
      renameSync(path, aside);
      log.warn(`database moved to ${aside}; recreating`);
      db = open(path);
      runMigrations(db, path);
      recovered = true;
    } else {
      throw e;
    }
  }
  return { db, recovered };
}

export function getDb(): Db {
  if (!db) throw new Error('Database not opened');
  return db;
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (e) {
    log.warn('close failed', e);
  } finally {
    db = null;
  }
}
