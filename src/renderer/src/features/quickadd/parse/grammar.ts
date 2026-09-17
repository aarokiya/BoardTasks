/**
 * The closed quick-add grammar. Every matcher is a pure function of the word
 * array — no clock, no locale, no context. Dates come out as a `DateSpec`
 * descriptor which `resolve.ts` turns into a civil date against the injected
 * `today`, so the same phrase is testable at any point in the calendar.
 */
import type { Priority } from '@shared/models';
import { norm, type Word } from './tokenize';

export type DateSpec =
  | { k: 'today' }
  | { k: 'tomorrow' }
  | { k: 'yesterday' }
  | { k: 'tonight' }
  | { k: 'weekday'; wd: number; mode: 'bare' | 'this' | 'next' }
  | { k: 'offset'; n: number; unit: 'day' | 'week' | 'month' }
  | { k: 'nextWeek' }
  | { k: 'nextMonth' }
  | { k: 'eow' }
  | { k: 'eom' }
  | { k: 'weekend'; mode: 'this' | 'next' }
  /** Month name form; `year: null` means "the next occurrence of this month/day". */
  | { k: 'ymd'; year: number | null; month: number; day: number }
  /** Ambiguous numeric form; `dateOrder` decides which of a/b is the month. */
  | { k: 'numeric'; a: number; b: number; year: number | null };

export interface DateMatch {
  spec: DateSpec;
  /** How many words the phrase consumed. */
  consumed: number;
}

export interface TimeMatch {
  /** 'HH:mm', 24-hour. */
  time: string;
  consumed: number;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, suns: 0,
  monday: 1, mon: 1, mons: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, fris: 5,
  saturday: 6, sat: 6, sats: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const SMALL_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const TODAY_WORDS = new Set(['today', 'tod', 'tdy', 'eod']);
const TOMORROW_WORDS = new Set(['tomorrow', 'tmr', 'tom', 'tmrw', 'tmw', 'tomo']);
const YESTERDAY_WORDS = new Set(['yesterday', 'yest']);
const TONIGHT_WORDS = new Set(['tonight', 'tonite']);

/** Time-of-day the word "tonight" implies. */
export const TONIGHT_TIME = '20:00';

/** Lower-cased, punctuation-trimmed word at `i`, or null when absent or literal. */
function at(words: Word[], i: number): string | null {
  const w = words[i];
  if (!w || w.literal || w.hash) return null;
  return norm(w);
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

function dayNumber(s: string): number | null {
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  if (!m) return null;
  const d = Number(m[1]);
  return d >= 1 && d <= 31 ? d : null;
}

function yearNumber(s: string): number | null {
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    return y >= 1900 && y <= 2999 ? y : null;
  }
  return null;
}

/** Two-digit years pivot at 69: 00–68 → 2000s, 69–99 → 1900s. */
export function pivotYear(yy: number): number {
  return yy < 69 ? 2000 + yy : 1900 + yy;
}

function countNumber(s: string): number | null {
  if (/^\d{1,4}$/.test(s)) return Number(s);
  return SMALL_NUMBERS[s] ?? null;
}

function unitOf(s: string): 'day' | 'week' | 'month' | null {
  if (s === 'day' || s === 'days') return 'day';
  if (s === 'week' || s === 'weeks' || s === 'wk' || s === 'wks') return 'week';
  if (s === 'month' || s === 'months' || s === 'mo' || s === 'mos') return 'month';
  return null;
}

/**
 * Longest date phrase starting at word `i`, or null. Tries 4-word forms first
 * so `next monday` never degrades into a bare `monday`.
 */
export function matchDate(words: Word[], i: number): DateMatch | null {
  const w0 = at(words, i);
  if (w0 === null) return null;
  const w1 = at(words, i + 1);
  const w2 = at(words, i + 2);

  // ---- three-word forms ----
  if (w1 !== null && w2 !== null) {
    // "in 3 days" / "in a week"
    if (w0 === 'in') {
      const n = countNumber(w1);
      const unit = unitOf(w2);
      if (n !== null && unit) return { spec: { k: 'offset', n, unit }, consumed: 3 };
    }
    // "end of week" / "end of month" / "end of day"
    if (w0 === 'end' && w1 === 'of') {
      if (w2 === 'week') return { spec: { k: 'eow' }, consumed: 3 };
      if (w2 === 'month') return { spec: { k: 'eom' }, consumed: 3 };
      if (w2 === 'day') return { spec: { k: 'today' }, consumed: 3 };
    }
    // "September 25 2026" / "Sep 25, 2026"
    const m3 = MONTHS[w0];
    const d3 = dayNumber(w1);
    const y3 = yearNumber(w2);
    if (m3 !== undefined && d3 !== null && y3 !== null) return { spec: { k: 'ymd', year: y3, month: m3, day: d3 }, consumed: 3 };
    // "25 Sep 2026"
    const d3b = dayNumber(w0);
    const m3b = MONTHS[w1];
    if (d3b !== null && m3b !== undefined && y3 !== null) return { spec: { k: 'ymd', year: y3, month: m3b, day: d3b }, consumed: 3 };
  }

  // ---- two-word forms ----
  if (w1 !== null) {
    if (w0 === 'next' || w0 === 'this' || w0 === 'coming') {
      const wd = WEEKDAYS[w1];
      if (wd !== undefined) return { spec: { k: 'weekday', wd, mode: w0 === 'next' ? 'next' : 'this' }, consumed: 2 };
      if (w1 === 'week') return { spec: w0 === 'next' ? { k: 'nextWeek' } : { k: 'eow' }, consumed: 2 };
      if (w1 === 'month') return { spec: w0 === 'next' ? { k: 'nextMonth' } : { k: 'eom' }, consumed: 2 };
      if (w1 === 'weekend') return { spec: { k: 'weekend', mode: w0 === 'next' ? 'next' : 'this' }, consumed: 2 };
    }
    // "Sep 25"
    const m2 = MONTHS[w0];
    const d2 = dayNumber(w1);
    if (m2 !== undefined && d2 !== null) return { spec: { k: 'ymd', year: null, month: m2, day: d2 }, consumed: 2 };
    // "25 Sep"
    const d2b = dayNumber(w0);
    const m2b = MONTHS[w1];
    if (d2b !== null && m2b !== undefined) return { spec: { k: 'ymd', year: null, month: m2b, day: d2b }, consumed: 2 };
  }

  // ---- one-word forms ----
  if (TODAY_WORDS.has(w0)) return { spec: { k: 'today' }, consumed: 1 };
  if (TOMORROW_WORDS.has(w0)) return { spec: { k: 'tomorrow' }, consumed: 1 };
  if (YESTERDAY_WORDS.has(w0)) return { spec: { k: 'yesterday' }, consumed: 1 };
  if (TONIGHT_WORDS.has(w0)) return { spec: { k: 'tonight' }, consumed: 1 };
  if (w0 === 'eow') return { spec: { k: 'eow' }, consumed: 1 };
  if (w0 === 'eom') return { spec: { k: 'eom' }, consumed: 1 };
  if (w0 === 'weekend') return { spec: { k: 'weekend', mode: 'this' }, consumed: 1 };
  const wd = WEEKDAYS[w0];
  if (wd !== undefined) return { spec: { k: 'weekday', wd, mode: 'bare' }, consumed: 1 };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(w0);
  if (iso) return { spec: { k: 'ymd', year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }, consumed: 1 };

  const num = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(w0);
  if (num) {
    const raw = num[3];
    const year = raw === undefined ? null : raw.length === 2 ? pivotYear(Number(raw)) : Number(raw);
    return { spec: { k: 'numeric', a: Number(num[1]), b: Number(num[2]), year }, consumed: 1 };
  }
  return null;
}

/** 'HH:mm' from an hour/minute/meridiem triple, or null when out of range. */
function clock(hour: number, minute: number, meridiem: 'am' | 'pm' | null): string | null {
  if (minute < 0 || minute > 59) return null;
  let h = hour;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    if (meridiem === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h < 0 || h > 23) return null;
  return `${pad2(h)}:${pad2(minute)}`;
}

/**
 * A single word as a time. 24-hour forms REQUIRE a colon, so "Call 12" is not
 * a time but "Call 12:00" is.
 */
export function parseTimeWord(sRaw: string): string | null {
  const s = sRaw.trim();
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(s);
  if (ampm) return clock(Number(ampm[1]), ampm[2] === undefined ? 0 : Number(ampm[2]), ampm[3] as 'am' | 'pm');
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (h24) return clock(Number(h24[1]), Number(h24[2]), null);
  return null;
}

/** Longest time phrase starting at word `i`: `@5pm`, `at 5:30pm`, `5 pm`, `17:30`, `noon`. */
export function matchTime(words: Word[], i: number): TimeMatch | null {
  const w = words[i];
  if (!w || w.literal || w.hash) return null;
  const s = norm(w);

  if (s.startsWith('@')) {
    const t = parseTimeWord(s.slice(1));
    return t ? { time: t, consumed: 1 } : null;
  }

  const next = at(words, i + 1);
  if (s === 'at' && next !== null) {
    const t = parseTimeWord(next);
    if (t) return { time: t, consumed: 2 };
  }
  if (next === 'am' || next === 'pm') {
    const t = parseTimeWord(`${s}${next}`);
    if (t) return { time: t, consumed: 2 };
  }
  const t = parseTimeWord(s);
  return t ? { time: t, consumed: 1 } : null;
}

/** `!1`, `!2`, `!3`, `!0`, `!p1`… — the whole word must be the token. */
export function matchPriority(w: Word): Priority | null {
  if (w.literal || w.hash) return null;
  const m = /^!p?([0-3])$/.exec(norm(w));
  return m ? (Number(m[1]) as Priority) : null;
}

/** A standalone `*` flags the task; `5*5` and `milk*` do not. */
export function matchFlag(w: Word): boolean {
  return !w.literal && !w.hash && norm(w) === '*';
}

/** `#work` / `#"Side projects"` → the raw query, or null. */
export function matchListQuery(w: Word): string | null {
  if (!w.hash) return null;
  const body = w.text.slice(1);
  if (body.startsWith('"')) {
    const closed = body.length >= 2 && body.endsWith('"');
    const inner = closed ? body.slice(1, -1) : body.slice(1);
    return inner.length ? inner : null;
  }
  const cleaned = body.replace(/[.,;:!?]+$/, '');
  return cleaned.length ? cleaned : null;
}
