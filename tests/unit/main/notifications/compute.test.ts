import { describe, expect, it } from 'vitest';
import { BACKLOG_MS, computeBacklog, computeNextFire, reminderInstant, sentKey } from '../../../../src/main/notifications/compute';
import { asCivil, localInstant } from '../../../../src/shared/date/civil';
import { DEFAULT_SETTINGS, type Settings, type Task } from '../../../../src/shared/models';

const DAY = asCivil('2026-09-17');

function task(over: Partial<Task> & { id: string }): Task {
  return {
    remoteId: null,
    listId: 'list-1',
    title: 'Task',
    notes: '',
    status: 'needsAction',
    due: DAY,
    dueTime: null,
    completedAt: null,
    parentId: null,
    sortKey: 'a0',
    priority: 0,
    flagged: false,
    hidden: false,
    deleted: false,
    webViewLink: null,
    links: [],
    github: null,
    sync: 'synced',
    conflict: null,
    rev: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: null,
    localUpdatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

const at = (time: string): number => localInstant(DAY, time);

describe('reminderInstant', () => {
  it('fires at the due time when one is set', () => {
    expect(reminderInstant(task({ id: 'a', dueTime: '14:00' }), settings({ notificationLeadMinutes: 0 }))).toBe(at('14:00'));
  });

  it('subtracts the lead minutes', () => {
    expect(reminderInstant(task({ id: 'a', dueTime: '14:00' }), settings({ notificationLeadMinutes: 15 }))).toBe(at('14:00') - 15 * 60_000);
  });

  it('uses the date-only reminder time verbatim — the lead would move a 09:00 digest into last night', () => {
    expect(reminderInstant(task({ id: 'a', dueTime: null }), settings({ dateOnlyReminderTime: '09:00', notificationLeadMinutes: 30 }))).toBe(at('09:00'));
  });

  it('has no reminder when there is no due date or no date-only time', () => {
    expect(reminderInstant(task({ id: 'a', due: null }), settings())).toBeNull();
    expect(reminderInstant(task({ id: 'a', dueTime: null }), settings({ dateOnlyReminderTime: null }))).toBeNull();
  });
});

describe('computeNextFire', () => {
  const noneSent = new Set<string>();

  it('returns null for an empty task set', () => {
    expect(computeNextFire([], settings(), at('08:00'), noneSent)).toBeNull();
  });

  it('returns null when notifications are off', () => {
    const tasks = [task({ id: 'a', dueTime: '14:00' })];
    expect(computeNextFire(tasks, settings({ notificationsEnabled: false }), at('08:00'), noneSent)).toBeNull();
  });

  it('picks the earliest upcoming instant', () => {
    const tasks = [task({ id: 'late', dueTime: '17:00' }), task({ id: 'early', dueTime: '09:30' }), task({ id: 'mid', dueTime: '12:00' })];
    expect(computeNextFire(tasks, settings(), at('08:00'), noneSent)).toEqual({ at: at('09:30'), taskIds: ['early'] });
  });

  it('groups every task sharing that instant', () => {
    const tasks = [task({ id: 'a', dueTime: '09:30' }), task({ id: 'b', dueTime: '09:30' }), task({ id: 'c', dueTime: '10:00' })];
    const next = computeNextFire(tasks, settings(), at('08:00'), noneSent);
    expect(next?.at).toBe(at('09:30'));
    expect(next?.taskIds.sort()).toEqual(['a', 'b']);
  });

  it('skips instants already in notifications_sent', () => {
    const tasks = [task({ id: 'a', dueTime: '09:30' }), task({ id: 'b', dueTime: '10:00' })];
    const sent = new Set([sentKey('a', at('09:30'))]);
    expect(computeNextFire(tasks, settings(), at('08:00'), sent)).toEqual({ at: at('10:00'), taskIds: ['b'] });
  });

  it('returns a past instant inside the backlog window so a slept-through reminder still fires', () => {
    const tasks = [task({ id: 'a', dueTime: '09:30' })];
    expect(computeNextFire(tasks, settings(), at('09:30') + 3 * 3600_000, noneSent)).toEqual({ at: at('09:30'), taskIds: ['a'] });
  });

  it('drops instants older than 24h — a week offline must not produce a burst', () => {
    const tasks = [task({ id: 'a', dueTime: '09:30' })];
    expect(computeNextFire(tasks, settings(), at('09:30') + BACKLOG_MS + 1, noneSent)).toBeNull();
  });

  it('ignores completed, hidden and deleted tasks', () => {
    const tasks = [
      task({ id: 'done', dueTime: '09:00', status: 'completed' }),
      task({ id: 'hidden', dueTime: '09:10', hidden: true }),
      task({ id: 'gone', dueTime: '09:20', deleted: true }),
      task({ id: 'open', dueTime: '09:30' }),
    ];
    expect(computeNextFire(tasks, settings(), at('08:00'), noneSent)).toEqual({ at: at('09:30'), taskIds: ['open'] });
  });
});

describe('computeBacklog', () => {
  it('collects only instants older than the backlog window', () => {
    const tasks = [task({ id: 'old', dueTime: '09:00' }), task({ id: 'recent', dueTime: '09:00', due: asCivil('2026-09-18') })];
    const now = localInstant(asCivil('2026-09-18'), '12:00');
    expect(computeBacklog(tasks, settings(), now, new Set()).map((m) => m.id)).toEqual(['old']);
  });

  it('is empty when the instants were already recorded', () => {
    const tasks = [task({ id: 'old', dueTime: '09:00' })];
    const now = localInstant(asCivil('2026-09-19'), '12:00');
    expect(computeBacklog(tasks, settings(), now, new Set([sentKey('old', at('09:00'))]))).toEqual([]);
  });
});
