import { useEffect, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { position, type Placement } from './position';
import { cx } from './cx';
import s from './overlays.module.css';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is positioned against and whose clicks don't dismiss it. */
  anchor: HTMLElement | null;
  placement?: Placement;
  label: string;
  role?: 'dialog' | 'menu' | 'listbox';
  children: ReactNode;
  flush?: boolean;
  className?: string;
  /** Focus the first focusable child on open. Default true. */
  autoFocus?: boolean;
}

export function Popover({
  open, onClose, anchor, placement = 'bottom-start', label, role = 'dialog', children, flush, className, autoFocus = true,
}: PopoverProps): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);

  // Positioned imperatively: a state round-trip would paint one frame at 0,0.
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const place = (): void => {
      const rect = anchor?.getBoundingClientRect() ?? { top: 0, left: 0, width: 0, height: 0 };
      const box = el.getBoundingClientRect();
      const p = position(rect, { width: box.width || 220, height: box.height || 160 }, placement);
      el.style.top = `${p.top}px`;
      el.style.left = `${p.left}px`;
      el.style.visibility = 'visible';
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchor, placement]);

  useEffect(() => {
    if (!open || !autoFocus) return;
    const el = ref.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>('button:not([disabled]), input, textarea, [tabindex]:not([tabindex="-1"])');
    (first ?? el).focus();
  }, [open, autoFocus]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (e: Event): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    };
    const armed = setTimeout(() => document.addEventListener('pointerdown', onPointerDown, true), 0);
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(armed);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={cx(s.popover, flush && s.popoverFlush, className)}
      style={{ top: 0, left: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
