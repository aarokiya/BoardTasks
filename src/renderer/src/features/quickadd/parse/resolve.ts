/**
 * Turns grammar descriptors into concrete civil dates / list ids against the
 * injected context. Nothing here reads a clock or a locale either.
 */
import { addDays, civilFromParts, civilParts, daysInMonth, endOfMonth, isCivil, nextWeekday, weekday, type CivilDate } from '@shared/date/civil';
import type { TaskList } from '@shared/models';
import { fuzzyMatch } from '../../palette/fuzzy';
import type { DateSpec } from './grammar';
import { TONIGHT_TIME } from './grammar';
import type { ParseContext, ParseWarning } from './types';

export interface ResolvedDate {
  due: CivilDate;
  /** Only `tonight` carries an implied time. */
  time?: string;
  warning?: ParseWarning;
}

/** Same day-of-month next month, clamped ("Jan 31" + 1 month → "Feb 28"). */
export function addMonths(d: CivilDate, n: number): CivilDate {
  const { year, month, day } = civilParts(d);
  const total = year * 12 + (month - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return civilFromParts(y, m, Math.min(day, daysInMonth(y, m)));
}

/** Sunday that starts the calendar week containing `d`. */
export function startOfWeek(d: CivilDate): CivilDate {
  return addDays(d, -weekday(d));
}

/** A month/day with no year: this year, or next year if that is already past. */
export function pickYear(today: CivilDate, month: number, day: number): number | null {
  const { year } = civilParts(today);
  if (day > daysInMonth(year, month)) {
    // Feb 29 in a non-leap year: walk forward to the next year that has it.
    for (let y = year + 1; y <= year + 8; y++) if (day <= daysInMonth(y, month)) return y;
    return null;
  }
  const candidate = civilFromParts(year, month, day);
  if (candidate >= today) return year;
  const next = year + 1;
  return day <= daysInMonth(next, month) ? next : null;
}

function ymd(today: CivilDate, year: number | null, month: number, day: number): ResolvedDate | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const y = year ?? pickYear(today, month, day);
  if (y === null) return null;
  if (day > daysInMonth(y, month)) return null;
  const s = `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isCivil(s) ? { due: s } : null;
}

/** Resolve a date descriptor. Returns null when the phrase is not a real date. */
export function resolveDate(spec: DateSpec, ctx: ParseContext): ResolvedDate | null {
  const today = ctx.today;
  switch (spec.k) {
    case 'today':
      return { due: today };
    case 'tomorrow':
      return { due: addDays(today, 1) };
    case 'yesterday':
      return { due: addDays(today, -1) };
    case 'tonight':
      return { due: today, time: TONIGHT_TIME };
    case 'weekday': {
      if (spec.mode === 'bare') return { due: nextWeekday(today, spec.wd) };
      const base = startOfWeek(today);
      if (spec.mode === 'next') return { due: addDays(base, 7 + spec.wd) };
      const candidate = addDays(base, spec.wd);
      if (candidate < today) {
        return { due: today, warning: { code: 'past-date', message: 'That day already passed this week — using today.', value: candidate } };
      }
      return { due: candidate };
    }
    case 'offset':
      if (spec.unit === 'day') return { due: addDays(today, spec.n) };
      if (spec.unit === 'week') return { due: addDays(today, spec.n * 7) };
      return { due: addMonths(today, spec.n) };
    case 'nextWeek':
      return { due: nextWeekday(today, 1) };
    case 'nextMonth':
      return { due: addMonths(today, 1) };
    case 'eow':
      return { due: nextWeekday(today, 5, true) };
    case 'eom':
      return { due: endOfMonth(today) };
    case 'weekend': {
      const sat = nextWeekday(today, 6, true);
      return { due: spec.mode === 'next' ? addDays(sat, 7) : sat };
    }
    case 'ymd':
      return ymd(today, spec.year, spec.month, spec.day);
    case 'numeric': {
      const mdy = ctx.dateOrder === 'MDY';
      const first = mdy ? spec.a : spec.b;
      const second = mdy ? spec.b : spec.a;
      const primary = ymd(today, spec.year, first, second);
      if (primary) return primary;
      // "25/9" under MDY (or "9/25" under DMY): only one reading is a real date.
      const swapped = ymd(today, spec.year, second, first);
      if (!swapped) return null;
      return {
        ...swapped,
        warning: { code: 'ambiguous-date', message: `Read as ${swapped.due} — ${spec.a}/${spec.b} is not a valid ${ctx.dateOrder} date.`, value: `${spec.a}/${spec.b}` },
      };
    }
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

/**
 * A bare time with no date means today if it is still ahead of us, otherwise
 * tomorrow. `now` is injected, so this is deterministic in tests.
 */
export function dateForBareTime(ctx: ParseContext, time: string): CivilDate {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const nowMinutes = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  return hh * 60 + mm > nowMinutes ? ctx.today : addDays(ctx.today, 1);
}

export interface ListResolution {
  listId: string | null;
  listQuery: string | null;
  warning?: ParseWarning;
}

/** Score below which a fuzzy list hit is treated as "no such list". */
export const LIST_MATCH_MIN_SCORE = 4;

/** Fuzzy-resolve a `#query` against the user's lists; exact/prefix hits win. */
export function resolveList(query: string, lists: TaskList[]): ListResolution {
  const lower = query.toLowerCase();
  const exact = lists.find((l) => l.title.toLowerCase() === lower);
  if (exact) return { listId: exact.id, listQuery: null };

  let best: { list: TaskList; score: number } | null = null;
  for (const l of lists) {
    const m = fuzzyMatch(query, l.title);
    if (!m || m.score <= LIST_MATCH_MIN_SCORE) continue;
    if (!best || m.score > best.score) best = { list: l, score: m.score };
  }
  if (best) return { listId: best.list.id, listQuery: null };
  return { listId: null, listQuery: query, warning: { code: 'unknown-list', message: `No list matches “${query}”.`, value: query } };
}
