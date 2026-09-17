import { copyFileSync, existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { createLogger } from '../logger';
import { MIGRATIONS } from './migrations';

const log = createLogger('db:migrate');

export function runMigrations(db: Database.Database, dbPath: string): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;
  if (current > 0 && dbPath !== ':memory:' && existsSync(dbPath)) {
    try {
      copyFileSync(dbPath, `${dbPath}.bak-v${current}`);
    } catch (e) {
      log.warn('pre-migration backup failed', e);
    }
  }
  for (const m of pending) {
    log.info(`applying migration ${m.version}: ${m.name}`);
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}
