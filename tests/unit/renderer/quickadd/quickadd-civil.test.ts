import { describe, expect, it } from 'vitest';
import type { TaskList } from '@shared/models';
import { addDays, endOfMonth, isCivil, todayCivil, weekday } from '@shared/date/civil';
import { parseQuickAdd, type ParseContext } from '@/features/quickadd/parse';

/**
 * The parser end of the civil-date trace, plus the edge phrases that are easy
 * to get wrong. Runs against the REAL system zone, so the suite is meaningful
 * under `TZ=Pacific/Kiritimati` and `TZ=America/Los_Angeles` — the two zones
 * where a date built through an instant lands a day out in opposite directions.
 *
 * The rest of the trace (repository → outbox → wire → pull) is in
 * tests/integration/due-date-roundtrip.test.ts.
 */

const lists: TaskList[] = [];

function ctx(now = new Date()): ParseContext {
  return { today: todayCivil(now), now, lists, defaultListId: 'L', dateOrder: 'MDY' };
}

const at = (h: number, m = 0): Date => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};

describe(`quick add civil dates (TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone})`, () => {
  it('resolves "tomorrow" against the LOCAL calendar day', () => {
    const c = ctx();
    const p = parseQuickAdd('Pay rent tomorrow', c);
    expect(p.title).toBe('Pay rent');
    expect(p.due).toBe(addDays(c.today, 1));
    expect(isCivil(p.due!)).toBe(true);
  });

  it('resolves "today" and "eom" against the local day', () => {
    const c = ctx();
    expect(parseQuickAdd('Ship it today', c).due).toBe(c.today);
    expect(parseQuickAdd('Invoice eom', c).due).toBe(endOfMonth(c.today));
  });
});

describe('quick add edge phrases', () => {
  it('"in 0 days" is today', () => {
    const c = ctx();
    expect(parseQuickAdd('Call in 0 days', c).due).toBe(c.today);
  });

  it('"0:30" is a time, and a past bare time rolls to tomorrow', () => {
    const c = ctx(at(9, 0));
    const p = parseQuickAdd('Standup 0:30', c);
    expect(p.dueTime).toBe('00:30');
    expect(p.due).toBe(addDays(c.today, 1));

    const later = parseQuickAdd('Standup 23:30', ctx(at(9, 0)));
    expect(later.due).toBe(todayCivil(at(9, 0)));
  });

  it('"13pm" is not a time', () => {
    const p = parseQuickAdd('Meet at 13pm', ctx());
    expect(p.dueTime).toBeNull();
    expect(p.title).toContain('13pm');
  });

  it('"Feb 30" is not a date', () => {
    const p = parseQuickAdd('Nonsense Feb 30', ctx());
    expect(p.due).toBeNull();
    expect(p.title).toBe('Nonsense Feb 30');
  });

  it('"next monday" on a Monday is seven days out, never today', () => {
    const c = ctx();
    // Walk to a Monday so the assertion holds on whatever day the suite runs.
    let monday = c.today;
    while (weekday(monday) !== 1) monday = addDays(monday, 1);
    const p = parseQuickAdd('Review next monday', { ...c, today: monday });
    expect(p.due).toBe(addDays(monday, 7));
  });

  it('"eom" on the last day of the month is that day', () => {
    const c = ctx();
    const last = endOfMonth(c.today);
    expect(parseQuickAdd('Wrap up eom', { ...c, today: last }).due).toBe(last);
  });

  it('"tonight" at 21:00 still means tonight, not tomorrow', () => {
    const c = ctx(at(21, 0));
    const p = parseQuickAdd('Pack tonight', c);
    expect(p.due).toBe(c.today);
    expect(p.dueTime).toBe('20:00');
  });

  it('a bare "#" and a bare "!" stay in the title', () => {
    const c = ctx();
    expect(parseQuickAdd('Sprint # planning', c).title).toBe('Sprint # planning');
    expect(parseQuickAdd('Wait ! here', c).title).toBe('Wait ! here');
    expect(parseQuickAdd('Wait ! here', c).priority).toBe(0);
  });

  it('keeps unicode titles intact', () => {
    const c = ctx();
    const p = parseQuickAdd('Réserver le café ☕ 日本語 tomorrow', c);
    expect(p.title).toBe('Réserver le café ☕ 日本語');
    expect(p.due).toBe(addDays(c.today, 1));
  });

  it('survives a very long line without truncating the parse', () => {
    const c = ctx();
    const long = `${'word '.repeat(2000)}tomorrow`;
    const p = parseQuickAdd(long, c);
    expect(p.due).toBe(addDays(c.today, 1));
    expect(p.title.startsWith('word')).toBe(true);
  });

  it('a date phrase alone stays as the title rather than producing an empty task', () => {
    const c = ctx();
    const p = parseQuickAdd('tomorrow', c);
    expect(p.title).toBe('tomorrow');
    expect(p.due).toBeNull();
  });
});
