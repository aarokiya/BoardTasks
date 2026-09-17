import { describe, expect, it } from 'vitest';

import { asCivil, localInstant, type CivilDate } from '../../../../src/shared/date/civil';
import { DEFAULT_SETTINGS, type Settings, type Task } from '../../../../src/shared/models';
import { computeBacklog, computeNextFire, reminderInstant, sentKey } from '../../../../src/main/notifications/compute';

/**
 * Reminder timing across the awkward days: a spring-forward Sunday, midnight
 * rollover, and the dedupe key that stops a restart re-firing what Notification
 * Center already shows.
 *
 * Run under `TZ=America/Los_Angeles` for the DST cases (2026-03-08, 02:00 →
 * 03:00) and under `TZ=UTC` to prove nothing depends on a particular offset.
 */

let seq = 0;
function task(due: CivilDate | null, dueTime: string | null, p: Partial<Task> = {}): Task {
  const id = `t${++seq}`;
  return {
    id, remoteId: null, listId: 'L', title: id, notes: '', status: 'needsAction', due, dueTime,
    completedAt: null, parentId: null, sortKey: `V${seq}`, priority: 0, flagged: false, hidden: false,
    deleted: false, webViewLink: null, links: [], github: null, sync: 'synced', conflict: null, rev: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, localUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  };
}

const settings = (p: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...p });

describe('reminder instants around a DST transition', () => {
  const springForward = asCivil('2026-03-08');

  it('a 09:00 reminder fires at 09:00 local on the spring-forward day', () => {
    const t = task(springForward, '09:00');
    const at = reminderInstant(t, settings({ notificationLeadMinutes: 0 }))!;
    expect(at).toBe(localInstant(springForward, '09:00'));
    expect(new Date(at).getHours()).toBe(9);
    expect(new Date(at).getMinutes()).toBe(0);
  });

  it('the lead is subtracted in real time, so 09:00 minus 15 is 08:45 local', () => {
    const at = reminderInstant(task(springForward, '09:00'), settings({ notificationLeadMinutes: 15 }))!;
    const d = new Date(at);
    expect([d.getHours(), d.getMinutes()]).toEqual([8, 45]);
  });

  it('the date-only reminder time is used verbatim on a DST day too', () => {
    const at = reminderInstant(task(springForward, null), settings({ dateOnlyReminderTime: '09:00', notificationLeadMinutes: 30 }))!;
    const d = new Date(at);
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 0]);
  });

  it('consecutive days are still consecutive across the transition', () => {
    const before = reminderInstant(task(asCivil('2026-03-07'), '09:00'), settings())!;
    const during = reminderInstant(task(springForward, '09:00'), settings())!;
    const after = reminderInstant(task(asCivil('2026-03-09'), '09:00'), settings())!;
    expect(during).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(during);
    // Each is 09:00 LOCAL, so the gaps are 23/24/25h depending on the zone —
    // never the same wall-clock arithmetic applied blindly.
    expect(new Date(before).getHours()).toBe(9);
    expect(new Date(after).getHours()).toBe(9);
  });
});

describe('computeNextFire', () => {
  it('rolls over midnight: tomorrow 00:00 is picked once today is exhausted', () => {
    const today = asCivil('2026-09-17');
    const tomorrow = asCivil('2026-09-18');
    const a = task(today, '23:59');
    const b = task(tomorrow, '00:00');
    const justAfterA = localInstant(today, '23:59') + 1_000;

    const next = computeNextFire([a, b], settings(), justAfterA, new Set([sentKey(a.id, localInstant(today, '23:59'))]));
    expect(next).not.toBeNull();
    expect(next!.taskIds).toEqual([b.id]);
    expect(next!.at).toBe(localInstant(tomorrow, '00:00'));
  });

  it('does not fire a task that was completed after the timer was armed', () => {
    const today = asCivil('2026-09-17');
    const t = task(today, '09:00');
    const armedAt = localInstant(today, '09:00');
    expect(computeNextFire([t], settings(), armedAt - 1000, new Set())!.taskIds).toEqual([t.id]);

    const completed = { ...t, status: 'completed' as const, completedAt: '2026-09-17T15:00:00.000Z' };
    expect(computeNextFire([completed], settings(), armedAt, new Set())).toBeNull();
  });

  it('dedupes on the exact instant, so moving the time re-arms but re-running does not', () => {
    const today = asCivil('2026-09-17');
    const t = task(today, '09:00');
    const at = localInstant(today, '09:00');
    const sent = new Set([sentKey(t.id, at)]);

    expect(computeNextFire([t], settings(), at, sent)).toBeNull();
    // Same task, different instant: a fresh reminder.
    const moved = { ...t, dueTime: '17:00' };
    expect(computeNextFire([moved], settings(), at, sent)!.taskIds).toEqual([t.id]);
  });

  it('changing the lead changes the key, so the reminder is not suppressed', () => {
    const today = asCivil('2026-09-17');
    const t = task(today, '09:00');
    const sent = new Set([sentKey(t.id, localInstant(today, '09:00'))]);
    const withLead = settings({ notificationLeadMinutes: 10 });
    expect(computeNextFire([t], withLead, localInstant(today, '08:00'), sent)!.at).toBe(localInstant(today, '08:50'));
  });

  it('a date-only task with no configured time never fires', () => {
    const t = task(asCivil('2026-09-17'), null);
    expect(computeNextFire([t], settings({ dateOnlyReminderTime: null }), Date.now(), new Set())).toBeNull();
    expect(computeBacklog([t], settings({ dateOnlyReminderTime: null }), Date.now(), new Set())).toEqual([]);
  });
});
