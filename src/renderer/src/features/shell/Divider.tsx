import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { cx } from '../../components/cx';
import s from './AppShell.module.css';

export interface DividerProps {
  /** Distance in px from the `side` edge of the container. */
  offset: number;
  side?: 'left' | 'right';
  value: number;
  min: number;
  max: number;
  label: string;
  /** Drag right increases the width of the pane on the left. */
  invert?: boolean;
  onChange: (value: number) => void;
}

/** 8px hit area, 1px visual line. Keyboard-resizable (arrows / Home / End). */
export function Divider({ offset, side = 'left', value, min, max, label, invert, onChange }: DividerProps): ReactElement {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, value });

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      start.current = { x: e.clientX, value };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [value],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent): void => {
      const delta = (e.clientX - start.current.x) * (invert ? -1 : 1);
      onChange(Math.round(Math.min(max, Math.max(min, start.current.value + delta))));
    };
    const onUp = (): void => setDragging(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, invert, min, max, onChange]);

  return (
    <div
      className={cx(s.divider, dragging && s.dividerActive)}
      style={side === 'right' ? { right: offset - 4 } : { left: offset - 4 }}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(Math.round((min + max) / 2))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8;
        if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(Math.max(min, value - (invert ? -step : step))); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); onChange(Math.min(max, value + (invert ? -step : step))); }
        else if (e.key === 'Home') { e.preventDefault(); onChange(min); }
        else if (e.key === 'End') { e.preventDefault(); onChange(max); }
      }}
    >
      <span className={s.dividerLine} aria-hidden="true" />
    </div>
  );
}
