import { useCallback, useEffect, useRef, type ReactElement, type TextareaHTMLAttributes } from 'react';
import s from './controls.module.css';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grows to fit content; never scrolls internally. */
  autoGrow?: boolean;
  minRows?: number;
}

export function Textarea({ autoGrow = true, minRows = 3, className, value, onChange, ...rest }: TextareaProps): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = useCallback(() => {
    const el = ref.current;
    if (!el || !autoGrow) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, minRows * 22)}px`;
  }, [autoGrow, minRows]);
  useEffect(grow, [grow, value]);
  return (
    <textarea
      ref={ref}
      className={[s.textarea, className ?? ''].filter(Boolean).join(' ')}
      rows={minRows}
      value={value}
      onChange={(e) => {
        onChange?.(e);
        grow();
      }}
      {...rest}
    />
  );
}
