import { describe, expect, it } from 'vitest';

import { addDays, asCivil, todayCivil, type CivilDate } from '../../../../src/shared/date/civil';
import type { ViewId } from '../../../../src/shared/constants';
import type { Task } from '../../../../src/shared/models';
import { selectCounts, selectRows } from '../../../../src/renderer/src/store/selectors/views';
import type { State } from '../../../../src/renderer/src/store/store';

/**
 * `completedAt` is an RFC3339 INSTANT from Google. Grouping the Completed view
 * by `completedAt.slice(0, 10)` compares a UTC calendar day against the user's
 * local one, so anything completed after 16:00 in Los Angeles (or before 10:00
 * in Kiritimati) lands in the wrong group.
 *
 * Run under `TZ=America/Los_Angeles` and `TZ=Pacific/Kiritimati`.
 */

let seq = 0;
function task(p: Partial<Task>): Task {
  const id = `t${++seq}`;
  return {
    id, remoteId: null, listId: 'L', title: id, notes: '', status: 'completed', due: null, dueTime: null,
    completedAt: null, parentId: null, sortKey: `V${seq}`, priority: 0, flagged: false, hidden: false,
    deleted: false, webViewLink: null, links: [], github: null, sync: 'synced', conflict: null, rev: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, localUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  };
}

let version = 0;
function stateWith(tasks: Task[], today: CivilDate): State {
  // The selectors memoize on `version`, exactly as the store does, so every
  // fixture needs its own — otherwise a later case reads an earlier result.
  return {
    version: ++version,
    view: 'completed',
    today,
    filterQuery: '',
    collapsedParents: {},
    showCompletedByList: {},
    settings: null,
    githubFilter: 'all',
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    lists: {},
  } as unknown as State;
}

/** Local noon and 23:00 on `day`, as the UTC instants Google would store. */
function localInstantIso(day: CivilDate, hour: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hour, 30, 0, 0).toISOString();
}

describe(`Completed view grouping (TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone})`, () => {
  it('groups by the LOCAL calendar day of completedAt, not the UTC one', () => {
    const today = todayCivil();
    // 00:30, 12:30 and 23:30 local are all "today" for the user; at least one of
    // them falls on a different UTC date in any zone with a non-zero offset.
    const early = task({ completedAt: localInstantIso(today, 0) });
    const midday = task({ completedAt: localInstantIso(today, 12) });
    const late = task({ completedAt: localInstantIso(today, 23) });

    const rows = selectRows(stateWith([early, midday, late], today));
    const groups = rows.filter((r) => r.kind === 'group');
    expect(groups.map((g) => g.label)).toEqual(['Today']);
    expect(groups[0]!.count).toBe(3);
  });

  it('keeps a task completed yesterday out of the Today group', () => {
    const today = asCivil('2026-09-17');
    const yesterday = asCivil('2026-09-16');
    const t = task({ completedAt: localInstantIso(yesterday, 12) });

    const rows = selectRows(stateWith([t], today));
    expect(rows.filter((r) => r.kind === 'group').map((g) => g.label)).toEqual(['Earlier']);
  });

  it('never crashes on a missing completedAt', () => {
    const today = todayCivil();
    const rows = selectRows(stateWith([task({ completedAt: null })], today));
    expect(rows.filter((r) => r.kind === 'group').map((g) => g.label)).toEqual(['Earlier']);
  });
});

const TODAY = asCivil('2026-09-17');
const open = (due: CivilDate | null): Task => task({ status: 'needsAction', due, completedAt: null });

function view(v: ViewId, tasks: Task[]): State {
  return { ...stateWith(tasks, TODAY), view: v };
}

describe('date-window boundaries', () => {
  it('Upcoming is strictly after today and includes today + 7', () => {
    const tasks = [-1, 0, 1, 7, 8].map((n) => open(addDays(TODAY, n)));
    const dues = selectRows(view('upcoming', tasks))
      .filter((r) => r.kind === 'task')
      .map((r) => r.task!.due);
    expect(dues).toEqual([addDays(TODAY, 1), addDays(TODAY, 7)]);
  });

  it('Today holds everything due on or before today, split into Overdue and Today', () => {
    const tasks = [-2, -1, 0, 1].map((n) => open(addDays(TODAY, n)));
    const rows = selectRows(view('today', tasks));
    const groups = rows.filter((r) => r.kind === 'group');
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ['Overdue', 2],
      ['Today', 1],
    ]);
  });

  it('Overdue splits at yesterday and at today minus seven', () => {
    const tasks = [-1, -2, -7, -8].map((n) => open(addDays(TODAY, n)));
    const groups = selectRows(view('overdue', tasks)).filter((r) => r.kind === 'group');
    // "Last week" is [today-7, yesterday); today-8 falls into "Earlier".
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ['Yesterday', 1],
      ['Last week', 2],
      ['Earlier', 1],
    ]);
  });

  it('a task with no date appears only in No date and All', () => {
    const t = open(null);
    expect(selectRows(view('nodate', [t])).filter((r) => r.kind === 'task')).toHaveLength(1);
    expect(selectRows(view('today', [t])).filter((r) => r.kind === 'task')).toHaveLength(0);
    expect(selectRows(view('upcoming', [t])).filter((r) => r.kind === 'task')).toHaveLength(0);
    expect(selectRows(view('overdue', [t])).filter((r) => r.kind === 'task')).toHaveLength(0);
  });

  it('counts agree with the view predicates', () => {
    const tasks = [-1, 0, 3, 30, null].map((n) => open(n === null ? null : addDays(TODAY, n)));
    const c = selectCounts(view('today', tasks));
    expect(c.today).toBe(2); // overdue + due today
    expect(c.overdue).toBe(1);
    expect(c.upcoming).toBe(1);
    expect(c.nodate).toBe(1);
    expect(c.all).toBe(5);
  });
});
