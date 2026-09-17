import { useEffect, useRef, useState, type ReactElement } from 'react';
import { formatTime12 } from '@shared/date/format';
import { announce } from '../../lib/announce';
import { useStore } from '../../store/store';
import { recordUndoable } from '../undo';
import { parseTimeWord } from './parse';
import s from './TimePicker.module.css';

const COMMON = ['08:00', '09:00', '12:00', '14:00', '17:00', '18:30', '20:00', '21:00'];

export interface TimePickerProps {
  value: string | null;
  onPick: (time: string | null) => void;
  onClose: () => void;
}

/** Reminder-time popover. Accepts "5pm", "17:30", "noon" as well as the presets. */
export function TimePicker({ value, onPick, onClose }: TimePickerProps): ReactElement {
  const [text, setText] = useState(value ?? '');
  const [error, setError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const commit = (): void => {
    const raw = text.trim().toLowerCase();
    if (raw === '') {
      onPick(null);
      return;
    }
    const parsed = parseTimeWord(raw);
    if (!parsed) {
      setError(true);
      return;
    }
    onPick(parsed);
  };

  return (
    <div
      className={s.popover}
      ref={rootRef}
      role="dialog"
      aria-label="Reminder time"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        className={error ? `${s.input} ${s.invalid}` : s.input}
        type="text"
        value={text}
        aria-label="Time"
        aria-invalid={error || undefined}
        placeholder="5pm, 17:30, noon"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setError(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {error ? <p className={s.error}>Try “5pm”, “17:30” or “noon”.</p> : null}
      <div className={s.presets}>
        {COMMON.map((t) => (
          <button key={t} type="button" className={t === value ? `${s.preset} ${s.selected}` : s.preset} onClick={() => onPick(t)}>
            {formatTime12(t)}
          </button>
        ))}
      </div>
      <button type="button" className={s.clear} onClick={() => onPick(null)}>
        No reminder time
      </button>
    </div>
  );
}

function payloadTaskIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || !('taskIds' in payload)) return [];
  const ids: unknown = payload.taskIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/** Rendered by the app shell when store.overlay === 'time-picker'; payload = { taskIds }. */
export function TimePickerOverlay(): ReactElement | null {
  const overlay = useStore((st) => st.overlay);
  const payload = useStore((st) => st.overlayPayload);
  const closeOverlay = useStore((st) => st.closeOverlay);
  const open = overlay === 'time-picker';
  const taskIds = open ? payloadTaskIds(payload) : [];
  const current = useStore((st) => (taskIds[0] ? (st.tasks[taskIds[0]]?.dueTime ?? null) : null));

  if (!open || taskIds.length === 0) return null;

  const apply = (time: string | null): void => {
    const store = useStore.getState();
    const before = taskIds.map((id) => ({ id, dueTime: store.tasks[id]?.dueTime ?? null }));
    const run = async (): Promise<void> => {
      await Promise.all(taskIds.map((id) => store.updateTask(id, { dueTime: time }).catch(() => null)));
    };
    const revert = async (): Promise<void> => {
      await Promise.all(before.map((b) => useStore.getState().updateTask(b.id, { dueTime: b.dueTime }).catch(() => null)));
    };
    void run();
    recordUndoable({ label: 'Set reminder time', apply: run, revert });
    announce(time ? `Reminder at ${formatTime12(time)}` : 'Reminder time cleared');
    closeOverlay();
  };

  return (
    <div className={s.scrim} onMouseDown={closeOverlay} data-testid="time-picker-overlay">
      <div className={s.anchor} onMouseDown={(e) => e.stopPropagation()}>
        <TimePicker value={current} onPick={apply} onClose={closeOverlay} />
      </div>
    </div>
  );
}
