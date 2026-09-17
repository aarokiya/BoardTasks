import { useEffect, useRef, type ReactElement, type RefObject, type TextareaHTMLAttributes } from 'react';
import s from './controls.module.css';

/**
 * Keeps a `resize: none; overflow: hidden` textarea tall enough for its text.
 * Re-measures on value change AND on width change: without the resize
 * observer, narrowing the inspector rewraps the text into more lines while the
 * inline height stays, and the last line is silently clipped.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: unknown, minHeight = 0, enabled = true): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const grow = (): void => {
      el.style.height = 'auto';
      el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`;
    };
    grow();
    // Observe the PARENT: writing our own height inside an observer of
    // ourselves is a resize loop.
    const target = el.parentElement;
    if (!target || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(grow);
    ro.observe(target);
    return () => ro.disconnect();
  }, [ref, value, minHeight, enabled]);
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grows to fit content; never scrolls internally. */
  autoGrow?: boolean;
  minRows?: number;
}

export function Textarea({ autoGrow = true, minRows = 3, className, value, onChange, ...rest }: TextareaProps): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value, minRows * 22, autoGrow);
  return (
    <textarea
      ref={ref}
      className={[s.textarea, className ?? ''].filter(Boolean).join(' ')}
      rows={minRows}
      value={value}
      onChange={onChange}
      {...rest}
    />
  );
}
