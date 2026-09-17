import type { ReactElement } from 'react';
import s from './feedback.module.css';

export function Spinner({ size = 14, label }: { size?: number; label?: string }): ReactElement {
  return (
    <span className={s.spinner} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" focusable="false">
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.8" />
        <path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}
