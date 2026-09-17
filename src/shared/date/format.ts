import { addDays, civilParts, diffDays, weekday, type CivilDate } from './civil';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatWeekday(d: CivilDate, short = false): string {
  return (short ? WEEKDAYS_SHORT : WEEKDAYS)[weekday(d)] ?? '';
}

export function formatMonthDay(d: CivilDate, includeYear = false): string {
  const { year, month, day } = civilParts(d);
  const base = `${MONTHS_SHORT[month - 1]} ${day}`;
  return includeYear ? `${base}, ${year}` : base;
}

export function formatLong(d: CivilDate): string {
  const { year, month, day } = civilParts(d);
  return `${formatWeekday(d)}, ${MONTHS_LONG[month - 1]} ${day}, ${year}`;
}

/**
 * Relative label for list rows: "Today", "Tomorrow", "Yesterday", "Sat",
 * "Sep 25", "3 days ago", "Sep 25, 2025" for other years.
 */
export function formatRelative(d: CivilDate, today: CivilDate): string {
  const diff = diffDays(today, d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return formatWeekday(d, true);
  if (diff < -1 && diff > -7) return `${-diff} days ago`;
  const sameYear = civilParts(d).year === civilParts(today).year;
  return formatMonthDay(d, !sameYear);
}

/** Group label for the Upcoming view: "Tomorrow", "Wednesday", "Thu, Sep 25". */
export function formatUpcomingGroup(d: CivilDate, today: CivilDate): string {
  const diff = diffDays(today, d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return formatWeekday(d);
  return `${formatWeekday(d, true)}, ${formatMonthDay(d)}`;
}

export function formatTime12(time: string): string {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const suffix = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

export function formatDueWithTime(d: CivilDate, time: string | null, today: CivilDate): string {
  const base = formatRelative(d, today);
  return time ? `${base} ${formatTime12(time)}` : base;
}

/** "just now", "4 min ago", "2 hours ago", "3 days ago" — for sync status and GitHub cards. */
export function formatAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export { addDays };
