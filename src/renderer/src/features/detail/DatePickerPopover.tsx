import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { addDays, civilFromParts, civilParts, daysInMonth, TIME_RE, weekday, type CivilDate } from '@shared/date/civil';
import { formatRelative } from '@shared/date/format';
import { Popover } from '../../components/Popover';
import { IconButton } from '../../components/IconButton';
import { IconChevronLeft, IconChevronRight, IconClock } from '../../components/icons';
import { cx } from '../../components/cx';
import s from './DatePicker.module.css';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** First day of the 6×7 grid containing `month` (always a Sunday). */
function gridStart(year: number, month: number): CivilDate {
  const first = civilFromParts(year, month, 1);
  return addDays(first, -weekday(first));
}

function addMonths(d: CivilDate, delta: number): CivilDate {
  const { year, month, day } = civilParts(d);
  const total = year * 12 + (month - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return civilFromParts(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

export interface DatePickerBodyProps {
  due: CivilDate | null;
  dueTime: string | null;
  today: CivilDate;
  onChange: (due: CivilDate | null, dueTime: string | null) => void;
  /** Called when the user finished (quick chip, Enter). */
  onDone: () => void;
  /** Focus the grid on mount. */
  autoFocus?: boolean;
  /**
   * Show the local reminder-time field. Off where a separate time control
   * already exists (quick add has its own time chip).
   */
  showTime?: boolean;
}

/**
 * Month grid + quick chips + local-only reminder time. Mounted fresh every
 * time the surface around it opens, so it never carries stale state.
 */
export function DatePickerBody({ due, dueTime, today, onChange, onDone, autoFocus = true, showTime = true }: DatePickerBodyProps): ReactElement {
  const [cursor, setCursor] = useState<CivilDate>(due ?? today);
  const [focused, setFocused] = useState<CivilDate>(due ?? today);
  const [timeText, setTimeText] = useState<string>(dueTime ?? '');
  const gridRef = useRef<HTMLDivElement>(null);
  const didFocus = useRef(false);

  useEffect(() => {
    if (!autoFocus || didFocus.current) return;
    const el = gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]');
    if (el) {
      el.focus();
      didFocus.current = true;
    }
  }, [autoFocus, focused]);

  const { year, month } = civilParts(cursor);
  const days = useMemo(() => {
    const start = gridStart(year, month);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [year, month]);

  const moveFocus = useCallback((next: CivilDate) => {
    setFocused(next);
    const p = civilParts(next);
    setCursor((cur) => {
      const c = civilParts(cur);
      return c.year === p.year && c.month === p.month ? cur : civilFromParts(p.year, p.month, 1);
    });
    didFocus.current = false;
  }, []);

  const currentTime = (): string | null => {
    const t = timeText.trim();
    return TIME_RE.test(t) ? t : null;
  };

  const commitTime = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange(due, null);
      return;
    }
    if (TIME_RE.test(trimmed)) onChange(due, trimmed);
  };

  const pick = (d: CivilDate, done: boolean): void => {
    onChange(d, currentTime());
    setFocused(d);
    if (done) onDone();
  };

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    let next: CivilDate;
    switch (e.key) {
      case 'ArrowLeft': next = addDays(focused, -1); break;
      case 'ArrowRight': next = addDays(focused, 1); break;
      case 'ArrowUp': next = addDays(focused, -7); break;
      case 'ArrowDown': next = addDays(focused, 7); break;
      case 'Home': next = addDays(focused, -weekday(focused)); break;
      case 'End': next = addDays(focused, 6 - weekday(focused)); break;
      case 'PageUp': next = addMonths(focused, e.shiftKey ? -12 : -1); break;
      case 'PageDown': next = addMonths(focused, e.shiftKey ? 12 : 1); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(focused, true);
        return;
      default:
        return;
    }
    e.preventDefault();
    moveFocus(next);
  };

  const timeTrimmed = timeText.trim();
  const timeInvalid = timeTrimmed !== '' && !TIME_RE.test(timeTrimmed);

  // The hint is the date, not a restatement of the label: "Today · Today"
  // and "Tomorrow · Tomorrow" are noise, so they are dropped.
  const chip = (id: string, label: string, date: CivilDate | null): { id: string; label: string; date: CivilDate | null; hint: string | null } => {
    if (date === null) return { id, label, date, hint: null };
    const relative = formatRelative(date, today);
    return { id, label, date, hint: relative.toLowerCase() === label.toLowerCase() ? null : relative };
  };

  const quick = [
    chip('today', 'Today', today),
    chip('tomorrow', 'Tomorrow', addDays(today, 1)),
    chip('nextweek', 'Next week', addDays(today, 7)),
    chip('clear', 'Clear', null),
  ];

  return (
    <div className={s.picker}>
      <div className={s.chips}>
        {quick.map((q) => (
          <button
            key={q.id}
            type="button"
            className={cx(s.chip, q.date === null && s.chipClear)}
            onClick={() => {
              if (q.date === null) {
                setTimeText('');
                onChange(null, null);
              } else {
                onChange(q.date, currentTime());
              }
              onDone();
            }}
          >
            <span className={s.chipLabel}>{q.label}</span>
            {q.hint ? <span className={s.chipHint}>{q.hint}</span> : null}
          </button>
        ))}
      </div>

      <div className={s.divider} />

      <div className={s.monthBar}>
        <IconButton size="sm" label="Previous month" icon={<IconChevronLeft size={14} />} onClick={() => setCursor(addMonths(cursor, -1))} />
        <span className={s.monthLabel} aria-live="polite">{`${MONTHS[month - 1] ?? ''} ${year}`}</span>
        <IconButton size="sm" label="Next month" icon={<IconChevronRight size={14} />} onClick={() => setCursor(addMonths(cursor, 1))} />
      </div>

      <div ref={gridRef} role="grid" aria-label={`${MONTHS[month - 1] ?? ''} ${year}`} className={s.grid} onKeyDown={onGridKeyDown}>
        {WEEKDAY_INITIALS.map((w, i) => (
          <div key={WEEKDAY_NAMES[i]} role="columnheader" aria-label={WEEKDAY_NAMES[i]} className={s.weekday}>
            {w}
          </div>
        ))}
        {days.map((d) => {
          const p = civilParts(d);
          const outside = p.month !== month;
          const selected = due !== null && due === d;
          const isToday = d === today;
          return (
            <button
              key={d}
              type="button"
              role="gridcell"
              aria-selected={selected}
              aria-current={isToday ? 'date' : undefined}
              aria-label={`${WEEKDAY_NAMES[weekday(d)] ?? ''}, ${MONTHS[p.month - 1] ?? ''} ${p.day}, ${p.year}`}
              tabIndex={d === focused ? 0 : -1}
              data-bt-autofocus={d === focused ? '' : undefined}
              className={cx(s.day, outside && s.dayOutside, isToday && !selected && s.dayToday, selected && s.daySelected)}
              onClick={() => pick(d, false)}
              onFocus={() => setFocused(d)}
            >
              {p.day}
            </button>
          );
        })}
      </div>

      {showTime ? (
        <>
      <div className={s.divider} />

      <div className={s.timeRow}>
        <span className={s.timeIcon} aria-hidden="true">
          <IconClock size={14} />
        </span>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Reminder time"
          placeholder="HH:mm"
          maxLength={5}
          className={cx(s.timeInput, timeInvalid && s.timeInvalid)}
          value={timeText}
          aria-invalid={timeInvalid || undefined}
          onChange={(e) => setTimeText(e.currentTarget.value)}
          onBlur={(e) => commitTime(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitTime(e.currentTarget.value);
              onDone();
            }
          }}
        />
      </div>
      {timeInvalid ? (
        <div className={s.error}>Use 24-hour HH:mm, for example 09:30.</div>
      ) : (
        <div className={s.hint}>Reminder time is stored on this Mac only — Google Tasks has no time-of-day.</div>
      )}
        </>
      ) : null}
    </div>
  );
}

export interface DatePickerPopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  due: CivilDate | null;
  dueTime: string | null;
  onChange: (due: CivilDate | null, dueTime: string | null) => void;
  today: CivilDate;
}

export function DatePickerPopover({ open, onClose, anchor, due, dueTime, onChange, today }: DatePickerPopoverProps): ReactElement | null {
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="bottom-start" label="Choose a due date" role="dialog" flush autoFocus={false}>
      <DatePickerBody due={due} dueTime={dueTime} today={today} onChange={onChange} onDone={onClose} />
    </Popover>
  );
}
