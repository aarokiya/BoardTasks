/**
 * Civil (calendar) dates — 'YYYY-MM-DD' strings in the user's local calendar.
 *
 * Google Tasks stores `due` as an RFC3339 timestamp but the time component is
 * meaningless: the API discards it and always returns midnight UTC. Treating it
 * as an instant is THE off-by-one-day bug in every Google Tasks client:
 *   new Date('2026-09-18T00:00:00.000Z') in Los Angeles is Sep 17.
 *   new Date(2026, 8, 18).toISOString() in Tokyo is '2026-09-17T15:00:00Z'.
 *
 * So: never build a Date from a due string, never toISOString() a local Date.
 * This module is the only place allowed to do either (see eslint config).
 */

declare const civilBrand: unique symbol;
/** 'YYYY-MM-DD'. Sorts lexicographically === chronologically. */
export type CivilDate = string & { readonly [civilBrand]: true };

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function isCivil(s: unknown): s is CivilDate {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export function asCivil(s: string): CivilDate {
  if (!isCivil(s)) throw new RangeError(`Not a civil date: ${s}`);
  return s;
}

export function daysInMonth(year: number, month1: number): number {
  // Sanctioned Date use: pure UTC calendar arithmetic, no local-zone involvement.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function civilFromParts(year: number, month1: number, day: number): CivilDate {
  return asCivil(`${String(year).padStart(4, '0')}-${pad2(month1)}-${pad2(day)}`);
}

export function civilParts(d: CivilDate): { year: number; month: number; day: number } {
  const [year, month, day] = d.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

/** Parse Google's `due` ('2026-09-18T00:00:00.000Z') → '2026-09-18'. Never constructs a Date. */
export function civilFromGoogleDue(due: string | null | undefined): CivilDate | null {
  if (!due) return null;
  const head = due.slice(0, 10);
  return isCivil(head) ? head : null;
}

/** Serialize for the Google API. Never uses toISOString() on a local Date. */
export function googleDueFromCivil(d: CivilDate): string {
  return `${d}T00:00:00.000Z`;
}

/** Today's civil date in the given IANA zone (default: system zone). */
export function todayCivil(now: Date = new Date(), timeZone?: string): CivilDate {
  // en-CA formats as YYYY-MM-DD; the only dependency-free correct approach.
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (timeZone) opts.timeZone = timeZone;
  const s = new Intl.DateTimeFormat('en-CA', opts).format(now);
  // Some ICU builds emit U+2010 or different separators; normalize defensively.
  return asCivil(s.replace(/[^\d]/g, '-').slice(0, 10));
}

/** Civil date of an instant (e.g. a `completed` timestamp) in the local zone. */
export function civilFromInstant(iso: string, timeZone?: string): CivilDate | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return todayCivil(new Date(t), timeZone);
}

/** Calendar arithmetic via a UTC-noon proxy — DST can never shift the day. */
export function addDays(d: CivilDate, n: number): CivilDate {
  const { year, month, day } = civilParts(d);
  const t = Date.UTC(year, month - 1, day, 12, 0, 0) + n * MS_PER_DAY;
  const r = new Date(t);
  return civilFromParts(r.getUTCFullYear(), r.getUTCMonth() + 1, r.getUTCDate());
}

/** b - a in whole days. */
export function diffDays(a: CivilDate, b: CivilDate): number {
  const pa = civilParts(a);
  const pb = civilParts(b);
  const ta = Date.UTC(pa.year, pa.month - 1, pa.day, 12);
  const tb = Date.UTC(pb.year, pb.month - 1, pb.day, 12);
  return Math.round((tb - ta) / MS_PER_DAY);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(d: CivilDate): number {
  const { year, month, day } = civilParts(d);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

export const isBefore = (a: CivilDate, b: CivilDate): boolean => a < b;
export const isAfter = (a: CivilDate, b: CivilDate): boolean => a > b;
export const isSame = (a: CivilDate, b: CivilDate): boolean => a === b;
export const compareCivil = (a: CivilDate, b: CivilDate): number => (a < b ? -1 : a > b ? 1 : 0);

export function endOfMonth(d: CivilDate): CivilDate {
  const { year, month } = civilParts(d);
  return civilFromParts(year, month, daysInMonth(year, month));
}

/** Next occurrence of weekday `wd` strictly after `from` (or `from` itself if allowSame). */
export function nextWeekday(from: CivilDate, wd: number, allowSame = false): CivilDate {
  const cur = weekday(from);
  let delta = (wd - cur + 7) % 7;
  if (delta === 0 && !allowSame) delta = 7;
  return addDays(from, delta);
}

/** Combine a civil date + 'HH:mm' into a local-zone instant (epoch ms). */
export function localInstant(d: CivilDate, time: string | null): number {
  const { year, month, day } = civilParts(d);
  const [hh, mm] = (time ?? '00:00').split(':').map(Number) as [number, number];
  // Sanctioned: constructing a LOCAL Date from civil parts is correct for
  // "when does this reminder fire on this machine".
  return new Date(year, month - 1, day, hh, mm, 0, 0).getTime();
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function isTimeString(s: unknown): s is string {
  return typeof s === 'string' && TIME_RE.test(s);
}
