import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, useInertBackground } from '../hooks/useFocusTrap';
import { IconButton } from './IconButton';
import { IconX } from './icons';
import { cx } from './cx';
import s from './overlays.module.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Footer with the destructive/secondary action pushed left. */
  footerSpread?: boolean;
  size?: 'md' | 'wide';
  tall?: boolean;
  /** Place the dialog near the top rather than centred (wizards, pickers). */
  alignTop?: boolean;
  flushBody?: boolean;
  showClose?: boolean;
  headerExtra?: ReactNode;
  /** Esc / scrim click dismiss. Default true. */
  dismissible?: boolean;
}

export function Dialog({
  open, onClose, title, description, children, footer, footerSpread, size = 'md', tall, alignTop,
  flushBody, showClose = true, headerExtra, dismissible = true,
}: DialogProps): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, open);
  useInertBackground(open);

  useEffect(() => {
    if (!open || !dismissible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose, dismissible]);

  if (!open) return null;
  return createPortal(
    <div
      className={cx(s.scrim, alignTop && s.scrimTop)}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        className={cx(s.dialog, size === 'wide' && s.dialogWide, tall && s.dialogTall)}
      >
        <header className={s.dialogHeader}>
          <h2 id={`${id}-title`} className={s.dialogTitle}>{title}</h2>
          {headerExtra}
          {showClose ? <IconButton label="Close" icon={<IconX />} onClick={onClose} /> : null}
        </header>
        <div className={cx(s.dialogBody, flushBody && s.dialogBodyFlush)}>
          {description ? <p id={`${id}-desc`} className="sr-only">{description}</p> : null}
          {children}
        </div>
        {footer ? <footer className={cx(s.dialogFooter, footerSpread && s.dialogFooterSpread)}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
