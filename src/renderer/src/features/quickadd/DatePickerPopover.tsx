import { useEffect, useRef, useState, type ReactElement } from 'react';
import { addDays, civilFromParts, civilParts, daysInMonth, nextWeekday, weekday, type CivilDate } from '@shared/date/civil';
import { formatMonthDay } from '@shared/date/format';
import { addMonths } from './parse';
import s from './DatePickerPopover.module.css';

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface DatePickerPopoverProps {
  value: CivilDate | null;
  today: CivilDate;
  onPick: (d: CivilDate | null) => void;
  onClose: () => void;
  /** Rendered inline (inside a popover shell the caller positions). */
  label?: string;
}

/** Small month grid used by the quick-add date chip and the task date command. */
export function DatePickerPopover({ value, today, onPick, onClose, label = 'Due date' }: DatePickerPopoverProps): ReactElement {
  const [cursor, setCursor] = useState<CivilDate>(value ?? today);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    first?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const { year, month } = civilParts(cursor);
  const firstOfMonth = civilFromParts(year, month, 1);
  const lead = weekday(firstOfMonth);
  const total = daysInMonth(year, month);
  const cells: Array<CivilDate | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: total }, (_, i) => civilFromParts(year, month, i + 1)),
  ];

  const presets: Array<[string, CivilDate | null]> = [
    ['Today', today],
    ['Tomorrow', addDays(today, 1)],
    ['This Weekend', nextWeekday(today, 6, true)],
    ['Next Week', nextWeekday(today, 1)],
  ];

  return (
    <div
      className={s.popover}
      ref={rootRef}
      role="dialog"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={s.presets}>
        {presets.map(([text, d], i) => (
          <button key={text} type="button" className={s.preset} data-autofocus={i === 0 ? '' : undefined} onClick={() => onPick(d)}>
            <span>{text}</span>
            {d ? <span className={s.presetDate}>{formatMonthDay(d)}</span> : null}
          </button>
        ))}
      </div>
      <div className={s.header}>
        <button type="button" className={s.nav} aria-label="Previous month" onClick={() => setCursor(addMonths(cursor, -1))}>
          ‹
        </button>
        <span className={s.monthLabel}>
          {MONTHS[month - 1]} {year}
        </span>
        <button type="button" className={s.nav} aria-label="Next month" onClick={() => setCursor(addMonths(cursor, 1))}>
          ›
        </button>
      </div>
      <div className={s.grid} role="grid" aria-label={`${MONTHS[month - 1]} ${year}`}>
        {DOW.map((d, i) => (
          <span key={`${d}${i}`} className={s.dow} aria-hidden="true">
            {d}
          </span>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <span key={`pad${i}`} className={s.pad} />
          ) : (
            <button
              key={d}
              type="button"
              className={[s.day, d === today ? s.isToday : '', d === value ? s.isSelected : ''].filter(Boolean).join(' ')}
              aria-label={d}
              aria-current={d === today ? 'date' : undefined}
              aria-pressed={d === value}
              onClick={() => onPick(d)}
            >
              {civilParts(d).day}
            </button>
          ),
        )}
      </div>
      <button type="button" className={s.clear} onClick={() => onPick(null)}>
        Clear date
      </button>
    </div>
  );
}
