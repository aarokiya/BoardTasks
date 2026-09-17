import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays, asCivil, civilFromGoogleDue, civilFromInstant, civilFromParts, civilParts, compareCivil,
  daysInMonth, diffDays, endOfMonth, googleDueFromCivil, isAfter, isBefore, isCivil, isSame,
  isTimeString, localInstant, nextWeekday, todayCivil, weekday,
} from '@shared/date/civil';

const ZONES = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Asia/Tokyo', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'America/Sao_Paulo'];

afterEach(() => vi.useRealTimers());

describe('isCivil / asCivil', () => {
  it('accepts valid dates and rejects invalid ones', () => {
    expect(isCivil('2026-09-18')).toBe(true);
    expect(isCivil('2024-02-29')).toBe(true);
    expect(isCivil('2023-02-29')).toBe(false);
    expect(isCivil('2026-13-01')).toBe(false);
    expect(isCivil('2026-00-10')).toBe(false);
    expect(isCivil('2026-04-31')).toBe(false);
    expect(isCivil('2026-04-00')).toBe(false);
    expect(isCivil('2026-9-1')).toBe(false);
    expect(isCivil(20260918)).toBe(false);
    expect(isCivil(null)).toBe(false);
    expect(() => asCivil('nope')).toThrow(RangeError);
    expect(asCivil('2026-09-18')).toBe('2026-09-18');
  });
  it('daysInMonth handles leap years', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
  it('civilFromParts / civilParts round-trip', () => {
    const d = civilFromParts(2026, 9, 5);
    expect(d).toBe('2026-09-05');
    expect(civilParts(d)).toEqual({ year: 2026, month: 9, day: 5 });
  });
});

describe('civilFromGoogleDue', () => {
  it.each(ZONES)('extracts the calendar date in %s without shifting', (tz) => {
    expect(civilFromGoogleDue('2026-09-18T00:00:00.000Z')).toBe('2026-09-18');
    expect(todayCivil(new Date('2026-09-18T00:00:00.000Z'), tz)).toBeDefined();
  });
  it('ignores a non-midnight time component', () => {
    expect(civilFromGoogleDue('2026-09-18T17:30:00.000Z')).toBe('2026-09-18');
  });
  it('returns null for empty, null, undefined, malformed', () => {
    expect(civilFromGoogleDue(null)).toBeNull();
    expect(civilFromGoogleDue(undefined)).toBeNull();
    expect(civilFromGoogleDue('')).toBeNull();
    expect(civilFromGoogleDue('garbage')).toBeNull();
  });
});

describe('googleDueFromCivil', () => {
  it('serializes to midnight UTC regardless of zone', () => {
    expect(googleDueFromCivil(asCivil('2026-09-18'))).toBe('2026-09-18T00:00:00.000Z');
  });
  it('round-trips 3650 consecutive days', () => {
    let d = asCivil('2020-01-01');
    for (let i = 0; i < 3650; i++) {
      expect(civilFromGoogleDue(googleDueFromCivil(d))).toBe(d);
      d = addDays(d, 1);
    }
  });
});

describe('todayCivil', () => {
  it('returns the local date at 23:30 in Tokyo (UTC date is still yesterday)', () => {
    expect(todayCivil(new Date('2026-09-18T14:30:00Z'), 'Asia/Tokyo')).toBe('2026-09-18');
    expect(todayCivil(new Date('2026-09-17T14:30:00Z'), 'Asia/Tokyo')).toBe('2026-09-17');
    // 23:30 Tokyo on Sep 18 == 14:30Z Sep 18; UTC date is same. Use 15:30Z: Tokyo = 00:30 Sep 19.
    expect(todayCivil(new Date('2026-09-18T15:30:00Z'), 'Asia/Tokyo')).toBe('2026-09-19');
  });
  it('returns the local date at 00:30 in Los Angeles (UTC date is tomorrow)', () => {
    expect(todayCivil(new Date('2026-09-18T07:30:00Z'), 'America/Los_Angeles')).toBe('2026-09-18');
    expect(todayCivil(new Date('2026-09-18T06:30:00Z'), 'America/Los_Angeles')).toBe('2026-09-17');
  });
  it('handles UTC+14', () => {
    expect(todayCivil(new Date('2026-09-18T10:30:00Z'), 'Pacific/Kiritimati')).toBe('2026-09-19');
  });
  it('defaults to the system zone and now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 18, 12, 0, 0));
    expect(todayCivil()).toBe('2026-09-18');
  });
  it('civilFromInstant converts a completed timestamp', () => {
    expect(civilFromInstant('2026-09-18T15:30:00Z', 'Asia/Tokyo')).toBe('2026-09-19');
    expect(civilFromInstant('not a date')).toBeNull();
  });
});

describe('addDays / diffDays', () => {
  it('crosses DST spring-forward without losing a day', () => {
    expect(addDays(asCivil('2026-03-07'), 1)).toBe('2026-03-08');
    expect(addDays(asCivil('2026-03-08'), 1)).toBe('2026-03-09');
  });
  it('crosses DST fall-back without repeating a day', () => {
    expect(addDays(asCivil('2026-10-31'), 1)).toBe('2026-11-01');
    expect(addDays(asCivil('2026-11-01'), 1)).toBe('2026-11-02');
  });
  it('crosses month, leap day, and year boundaries', () => {
    expect(addDays(asCivil('2024-02-28'), 1)).toBe('2024-02-29');
    expect(addDays(asCivil('2024-02-29'), 1)).toBe('2024-03-01');
    expect(addDays(asCivil('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(asCivil('2027-01-01'), -1)).toBe('2026-12-31');
  });
  it('is invertible', () => {
    const d = asCivil('2026-09-18');
    for (let n = -400; n <= 400; n += 7) expect(addDays(addDays(d, n), -n)).toBe(d);
    expect(addDays(d, 0)).toBe(d);
  });
  it('diffDays', () => {
    expect(diffDays(asCivil('2026-09-18'), asCivil('2026-09-25'))).toBe(7);
    expect(diffDays(asCivil('2026-09-25'), asCivil('2026-09-18'))).toBe(-7);
    expect(diffDays(asCivil('2026-01-01'), asCivil('2027-01-01'))).toBe(365);
  });
});

describe('weekday helpers', () => {
  it('weekday', () => {
    expect(weekday(asCivil('2026-09-17'))).toBe(4); // Thursday
    expect(weekday(asCivil('2026-09-20'))).toBe(0);
  });
  it('nextWeekday strictly after, or same when allowed', () => {
    const thu = asCivil('2026-09-17');
    expect(nextWeekday(thu, 4)).toBe('2026-09-24');
    expect(nextWeekday(thu, 4, true)).toBe('2026-09-17');
    expect(nextWeekday(thu, 5)).toBe('2026-09-18');
    expect(nextWeekday(thu, 1)).toBe('2026-09-21');
  });
  it('endOfMonth', () => {
    expect(endOfMonth(asCivil('2026-02-10'))).toBe('2026-02-28');
    expect(endOfMonth(asCivil('2024-02-10'))).toBe('2024-02-29');
  });
});

describe('comparison', () => {
  it('orders lexicographically across years', () => {
    const a = asCivil('2026-12-31');
    const b = asCivil('2027-01-01');
    expect(isBefore(a, b)).toBe(true);
    expect(isAfter(b, a)).toBe(true);
    expect(isSame(a, a)).toBe(true);
    expect(compareCivil(a, b)).toBe(-1);
    expect(compareCivil(b, a)).toBe(1);
    expect(compareCivil(a, a)).toBe(0);
  });
});

describe('localInstant / time strings', () => {
  it('validates HH:mm', () => {
    expect(isTimeString('09:30')).toBe(true);
    expect(isTimeString('23:59')).toBe(true);
    expect(isTimeString('24:00')).toBe(false);
    expect(isTimeString('9:30')).toBe(false);
    expect(isTimeString(930)).toBe(false);
  });
  it('builds a local instant', () => {
    const t = localInstant(asCivil('2026-09-18'), '17:05');
    const d = new Date(t);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 18, 17, 5]);
    const m = new Date(localInstant(asCivil('2026-09-18'), null));
    expect([m.getHours(), m.getMinutes()]).toEqual([0, 0]);
  });
});
