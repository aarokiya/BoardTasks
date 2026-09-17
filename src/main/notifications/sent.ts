/**
 * Persistence for "we already told the user about this reminder". Restarting
 * the app must not re-fire a reminder that already appeared in Notification
 * Center five minutes ago.
 */
import { getDb } from '../db/connection';
import { nowIso } from '../util/time';
import { fireAtIso } from './compute';

/** Task ids the summary notification uses; not a real task, so it can't collide. */
export const SUMMARY_TASK_ID = '__missed_summary__';

const RETENTION_DAYS = 30;

export function loadSentKeys(): Set<string> {
  const rows = getDb().prepare('SELECT task_id, fire_at FROM notifications_sent').all() as { task_id: string; fire_at: string }[];
  return new Set(rows.map((r) => `${r.task_id}@${r.fire_at}`));
}

export function markSent(taskId: string, fireAt: number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO notifications_sent (task_id, fire_at, sent_at) VALUES (?, ?, ?)')
    .run(taskId, fireAtIso(fireAt), nowIso());
}

/** Drops rows the scheduler can never consult again (older than the backlog window by far). */
export function pruneSent(now: number = Date.now()): number {
  const cutoff = fireAtIso(now - RETENTION_DAYS * 86_400_000);
  return getDb().prepare('DELETE FROM notifications_sent WHERE sent_at < ?').run(cutoff).changes;
}
