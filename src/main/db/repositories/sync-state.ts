import { getDb } from '../connection';
import { nowIso } from '../../util/time';

export interface SyncStateRow {
  scope: string; watermark: string | null; last_full_sync_at: string | null; last_delta_sync_at: string | null;
  last_success_at: string | null; last_error: string | null; consecutive_errors: number; server_skew_ms: number; updated_at: string;
}

export function getSyncState(scope: string): SyncStateRow {
  const r = getDb().prepare('SELECT * FROM sync_state WHERE scope = ?').get(scope) as SyncStateRow | undefined;
  return r ?? { scope, watermark: null, last_full_sync_at: null, last_delta_sync_at: null, last_success_at: null, last_error: null, consecutive_errors: 0, server_skew_ms: 0, updated_at: nowIso() };
}

export function setSyncState(scope: string, patch: Partial<Omit<SyncStateRow, 'scope' | 'updated_at'>>): void {
  const cur = getSyncState(scope);
  const next = { ...cur, ...patch, updated_at: nowIso() };
  getDb()
    .prepare(
      `INSERT INTO sync_state (scope, watermark, last_full_sync_at, last_delta_sync_at, last_success_at, last_error, consecutive_errors, server_skew_ms, updated_at)
       VALUES (@scope, @watermark, @last_full_sync_at, @last_delta_sync_at, @last_success_at, @last_error, @consecutive_errors, @server_skew_ms, @updated_at)
       ON CONFLICT(scope) DO UPDATE SET watermark = excluded.watermark, last_full_sync_at = excluded.last_full_sync_at, last_delta_sync_at = excluded.last_delta_sync_at,
       last_success_at = excluded.last_success_at, last_error = excluded.last_error, consecutive_errors = excluded.consecutive_errors, server_skew_ms = excluded.server_skew_ms, updated_at = excluded.updated_at`,
    )
    .run(next);
}

export function clearSyncState(): void {
  getDb().prepare('DELETE FROM sync_state').run();
}
