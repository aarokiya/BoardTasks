/**
 * Deterministic core of the reminder scheduler. No timers, no electron, no db —
 * `now` and the already-sent set are arguments, so every rule here is a plain
 * unit test with a fake clock.
 */
import { localInstant } from '@shared/date/civil';
import type { Settings, Task } from '@shared/models';

/** Reminders older than this are backlog, not alarms: one summary, never a burst. */
export const BACKLOG_MS = 24 * 60 * 60 * 1000;

export interface FireGroup {
  /** Epoch ms of the reminder instant. */
  at: number;
  /** Every task whose reminder lands on exactly this instant. */
  taskIds: string[];
}

/** Key for the notifications_sent table: stable for a given (task, instant). */
export function sentKey(taskId: string, fireAt: number): string {
  return `${taskId}@${fireAtIso(fireAt)}`;
}

export function fireAtIso(fireAt: number): string {
  return new Date(fireAt).toISOString();
}

/**
 * When this task's reminder should fire, or null if it has none.
 *
 * With a time-of-day: `lead` minutes before it. Without one: the user's
 * date-only reminder time, verbatim — subtracting the lead there would move a
 * 09:00 "morning digest" reminder into the previous evening.
 */
export function reminderInstant(task: Task, settings: Settings): number | null {
  if (task.due === null) return null;
  if (task.dueTime !== null) return localInstant(task.due, task.dueTime) - settings.notificationLeadMinutes * 60_000;
  if (settings.dateOnlyReminderTime !== null) return localInstant(task.due, settings.dateOnlyReminderTime);
  return null;
}

function candidates(tasks: readonly Task[], settings: Settings): Array<{ id: string; at: number }> {
  const out: Array<{ id: string; at: number }> = [];
  for (const t of tasks) {
    if (t.deleted || t.hidden || t.status !== 'needsAction') continue;
    const at = reminderInstant(t, settings);
    if (at !== null) out.push({ id: t.id, at });
  }
  return out;
}

/**
 * The next reminder instant to act on, and everything due at it.
 * Returns an instant in the past when a reminder was missed within the last
 * BACKLOG_MS — the caller fires those immediately, which is the correct
 * behaviour for a machine that slept through 14:00.
 */
export function computeNextFire(tasks: readonly Task[], settings: Settings, now: number, sent: ReadonlySet<string>): FireGroup | null {
  if (!settings.notificationsEnabled) return null;
  let best: number | null = null;
  for (const c of candidates(tasks, settings)) {
    if (c.at < now - BACKLOG_MS) continue;
    if (sent.has(sentKey(c.id, c.at))) continue;
    if (best === null || c.at < best) best = c.at;
  }
  if (best === null) return null;
  const at = best;
  return { at, taskIds: candidates(tasks, settings).filter((c) => c.at === at && !sent.has(sentKey(c.id, c.at))).map((c) => c.id) };
}

/**
 * Reminders that elapsed more than BACKLOG_MS ago while the app was not
 * running. These are reported as a single summary and then marked sent, so a
 * week offline does not produce a wall of notifications.
 */
export function computeBacklog(tasks: readonly Task[], settings: Settings, now: number, sent: ReadonlySet<string>): Array<{ id: string; at: number }> {
  if (!settings.notificationsEnabled) return [];
  return candidates(tasks, settings).filter((c) => c.at < now - BACKLOG_MS && !sent.has(sentKey(c.id, c.at)));
}
