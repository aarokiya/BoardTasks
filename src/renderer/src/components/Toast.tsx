import { useEffect, useRef, type ReactElement } from 'react';
import type { Toast as ToastModel } from '../store/store';
import { IconAlert, IconCheckCircle, IconInfo, IconX } from './icons';
import { IconButton } from './IconButton';
import { Button } from './Button';
import { cx } from './cx';
import s from './overlays.module.css';

const levelIcon = {
  info: <IconInfo size={15} />,
  success: <IconCheckCircle size={15} />,
  warn: <IconAlert size={15} />,
  error: <IconAlert size={15} />,
};
const levelClass = { info: s.toastInfo, success: s.toastSuccess, warn: s.toastWarn, error: s.toastError };

export interface ToastProps {
  toast: ToastModel;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss(toast.id);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [toast.id, onDismiss]);

  return (
    <div ref={ref} className={cx(s.toast, levelClass[toast.level])} data-level={toast.level}>
      <span className={s.toastIcon} aria-hidden="true">{levelIcon[toast.level]}</span>
      <span className={s.toastMessage}>{toast.message}</span>
      {toast.actionLabel && toast.onAction ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            toast.onAction?.();
            onDismiss(toast.id);
          }}
        >
          {toast.actionLabel}
        </Button>
      ) : null}
      <IconButton size="sm" label="Dismiss notification" icon={<IconX size={13} />} onClick={() => onDismiss(toast.id)} />
    </div>
  );
}
