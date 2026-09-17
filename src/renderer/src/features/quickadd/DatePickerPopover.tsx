import { useEffect, useRef, type ReactElement } from 'react';
import type { CivilDate } from '@shared/date/civil';
import { DatePickerBody } from '../detail/DatePickerPopover';
import s from './DatePickerPopover.module.css';

export interface DatePickerPopoverProps {
  value: CivilDate | null;
  today: CivilDate;
  onPick: (d: CivilDate | null) => void;
  onClose: () => void;
  /** Rendered inline (inside a popover shell the caller positions). */
  label?: string;
}

/**
 * The quick-add date chip's popover. This is only the shell — positioning,
 * dismissal and the accessible name; the calendar itself is the single
 * DatePickerBody the inspector uses, so there is one month grid in the app and
 * quick add gets its keyboard navigation for free.
 *
 * The reminder-time field is hidden here: quick add already has its own time
 * chip, and two ways to set the same value in one popover is a trap.
 */
export function DatePickerPopover({ value, today, onPick, onClose, label = 'Due date' }: DatePickerPopoverProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

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
      <DatePickerBody
        due={value}
        dueTime={null}
        today={today}
        showTime={false}
        onChange={(due) => onPick(due)}
        onDone={onClose}
      />
    </div>
  );
}
