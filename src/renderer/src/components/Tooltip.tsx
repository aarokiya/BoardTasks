import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { position } from './position';
import s from './overlays.module.css';

export interface TooltipProps {
  label: string;
  /**
   * The control to describe. It is wrapped in a `display: contents` span that
   * carries the hover/focus handlers — the child element is never cloned, so
   * its own ref and props survive untouched. Give the control its own
   * accessible name (IconButton does); the tooltip is a visual affordance.
   */
  children: ReactNode;
  delayMs?: number;
  placement?: 'top' | 'bottom' | 'right' | 'left';
  disabled?: boolean;
}

export function Tooltip({ label, children, delayMs = 450, placement = 'top', disabled }: TooltipProps): ReactElement {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = useCallback(
    (immediate: boolean) => {
      if (disabled) return;
      if (timer.current) clearTimeout(timer.current);
      if (immediate) setOpen(true);
      else timer.current = setTimeout(() => setOpen(true), delayMs);
    },
    [delayMs, disabled],
  );
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const el = tipRef.current;
    const a = anchorRef.current?.getBoundingClientRect();
    if (!el || !a) return;
    const box = el.getBoundingClientRect();
    const p = position(a, { width: box.width || 120, height: box.height || 24 }, placement);
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
    el.style.visibility = 'visible';
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hide]);

  const capture = (e: { currentTarget: EventTarget | null }): void => {
    const el = e.currentTarget;
    if (el instanceof HTMLElement) anchorRef.current = (el.firstElementChild as HTMLElement | null) ?? el;
  };

  return (
    <>
      <span
        className={s.tipAnchor}
        onMouseEnter={(e) => { capture(e); show(false); }}
        onMouseLeave={hide}
        onFocus={(e) => { capture(e); show(true); }}
        onBlur={hide}
      >
        {children}
      </span>
      {open && !disabled
        ? createPortal(
            <div id={id} ref={tipRef} role="tooltip" className={s.tooltip} style={{ top: 0, left: 0, visibility: 'hidden' }}>
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
