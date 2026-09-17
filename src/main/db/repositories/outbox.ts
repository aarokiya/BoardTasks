import type { OutboxEntry, OutboxOp, PreviousId } from '@shared/models';
import { getDb } from '../connection';
import { nowIso } from '../../util/time';
import { uuid } from '../../util/uuid';

export type OutboxPayload =
  | { kind: 'task.create'; fields: TaskWireFields; parentId: string | null; previousId: PreviousId }
  | { kind: 'task.update'; fields: Partial<TaskWireFields> }
  | { kind: 'task.delete' }
  | { kind: 'task.move'; parentId: string | null; previousId: PreviousId; destListId: string }
  | { kind: 'task.clear' }
  | { kind: 'list.create'; title: string }
  | { kind: 'list.update'; title: string }
  | { kind: 'list.delete' };

/** Fields that actually go over the wire to Google. dueTime/priority/flagged are local-only. */
export interface TaskWireFields {
  title: string;
  notes: string;
  status: 'needsAction' | 'completed';
  due: string | null; // civil date
  completedAt: string | null;
}

export interface OutboxRow {
  id: string; seq: number; op: OutboxOp; entity: 'task' | 'list'; entity_id: string; payload_json: string;
  description: string; base_etag: string | null; base_updated_at: string | null;
  status: OutboxEntry['status']; attempts: number; blocked_passes: number; next_attempt_at: string;
  last_error: string | null; last_error_code: string | null; created_at: string; updated_at: string;
}

export function rowToOutbox(r: OutboxRow): OutboxEntry {
  return {
    id: r.id, op: r.op, entity: r.entity, entityId: r.entity_id, description: r.description, status: r.status,
    attempts: r.attempts, nextAttemptAt: r.next_attempt_at, lastError: r.last_error, lastErrorCode: r.last_error_code,
    createdAt: r.created_at,
  };
}

export function payloadOf(r: OutboxRow): OutboxPayload {
  return JSON.parse(r.payload_json) as OutboxPayload;
}

export interface EnqueueInput {
  op: OutboxOp;
  entity: 'task' | 'list';
  entityId: string;
  payload: OutboxPayload;
  description: string;
  baseEtag?: string | null;
  baseUpdatedAt?: string | null;
}

/**
 * Append an outbox entry. Must be called inside the same transaction as the
 * local write it describes. Coalesces consecutive pending `task.update`s and
 * `list.update`s for the same entity so typing a title is one row, not forty.
 */
export function enqueue(input: EnqueueInput): string {
  const db = getDb();
  const now = nowIso();
  if (input.op === 'task.update' || input.op === 'list.update') {
    const existing = db
      .prepare(`SELECT * FROM outbox WHERE entity_id = ? AND op = ? AND status IN ('pending','blocked') ORDER BY seq DESC LIMIT 1`)
      .get(input.entityId, input.op) as OutboxRow | undefined;
    // Only coalesce if nothing else for this entity was queued after it (ordering must be preserved).
    if (existing) {
      const later = db.prepare(`SELECT COUNT(*) c FROM outbox WHERE entity_id = ? AND seq > ? AND status != 'done'`).get(input.entityId, existing.seq) as { c: number };
      if (later.c === 0) {
        const prev = payloadOf(existing);
        const merged = input.op === 'task.update' && prev.kind === 'task.update' && input.payload.kind === 'task.update'
          ? { kind: 'task.update' as const, fields: { ...prev.fields, ...input.payload.fields } }
          : input.payload;
        db.prepare(`UPDATE outbox SET payload_json = ?, description = ?, updated_at = ?, status = 'pending', next_attempt_at = ? WHERE id = ?`)
          .run(JSON.stringify(merged), input.description, now, now, existing.id);
        return existing.id;
      }
    }
  }
  const seq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) m FROM outbox').get() as { m: number }).m) + 1;
  const id = uuid();
  db.prepare(
    `INSERT INTO outbox (id, seq, op, entity, entity_id, payload_json, description, base_etag, base_updated_at, status, attempts, blocked_passes, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?)`,
  ).run(id, seq, input.op, input.entity, input.entityId, JSON.stringify(input.payload), input.description, input.baseEtag ?? null, input.baseUpdatedAt ?? null, now, now, now);
  return id;
}

/** Cancel every non-done entry for an entity (used when create-then-delete never needs the network). */
export function cancelAllFor(entityId: string): number {
  return getDb().prepare(`UPDATE outbox SET status = 'done', updated_at = ? WHERE entity_id = ? AND status != 'done'`).run(nowIso(), entityId).changes;
}

export function findPending(entityId: string, op: OutboxOp): OutboxRow | undefined {
  return getDb().prepare(`SELECT * FROM outbox WHERE entity_id = ? AND op = ? AND status IN ('pending','blocked') ORDER BY seq DESC LIMIT 1`).get(entityId, op) as OutboxRow | undefined;
}

export function hasPendingCreate(entityId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM outbox WHERE entity_id = ? AND op IN ('task.create','list.create') AND status != 'done' LIMIT 1`).get(entityId);
}

export function listOutbox(): OutboxEntry[] {
  return (getDb().prepare(`SELECT * FROM outbox WHERE status != 'done' ORDER BY seq ASC`).all() as OutboxRow[]).map(rowToOutbox);
}

export function listParked(): OutboxRow[] {
  return getDb().prepare(`SELECT * FROM outbox WHERE status = 'parked' ORDER BY seq ASC`).all() as OutboxRow[];
}

export function counts(): { pending: number; parked: number } {
  const r = getDb()
    .prepare(`SELECT SUM(CASE WHEN status IN ('pending','inflight','blocked') THEN 1 ELSE 0 END) p, SUM(CASE WHEN status = 'parked' THEN 1 ELSE 0 END) k FROM outbox`)
    .get() as { p: number | null; k: number | null };
  return { pending: r.p ?? 0, parked: r.k ?? 0 };
}

export function getOutboxRow(id: string): OutboxRow | undefined {
  return getDb().prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined;
}

export function updateOutbox(id: string, patch: Partial<Pick<OutboxRow, 'status' | 'attempts' | 'blocked_passes' | 'next_attempt_at' | 'last_error' | 'last_error_code'>>): void {
  const sets: string[] = ['updated_at = @updated_at'];
  const params: Record<string, unknown> = { id, updated_at: nowIso() };
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  getDb().prepare(`UPDATE outbox SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/** Purge done entries older than 7 days (keep the table small). */
export function vacuumDone(): void {
  getDb().prepare(`DELETE FROM outbox WHERE status = 'done' AND updated_at < ?`).run(new Date(Date.now() - 7 * 86_400_000).toISOString());
}

// ---------- sync-engine helpers (additive; the sync track owns the semantics) ----------

/** Raw rows in FIFO order for the outbox drain. Defaults to everything not done. */
export function listOutboxRows(statuses?: readonly OutboxRow['status'][]): OutboxRow[] {
  const db = getDb();
  if (!statuses || statuses.length === 0) {
    return db.prepare(`SELECT * FROM outbox WHERE status != 'done' ORDER BY seq ASC`).all() as OutboxRow[];
  }
  const holes = statuses.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM outbox WHERE status IN (${holes}) ORDER BY seq ASC`).all(...statuses) as OutboxRow[];
}

/** True when anything is still queued for an entity (pull must not delete it). */
export function hasPendingForEntity(entityId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM outbox WHERE entity_id = ? AND status != 'done' LIMIT 1`).get(entityId);
}

/** Rows left 'inflight' by a crash: nothing is actually in flight after a restart. */
export function recoverInflight(): number {
  return getDb().prepare(`UPDATE outbox SET status = 'pending', updated_at = ? WHERE status = 'inflight'`).run(nowIso()).changes;
}
