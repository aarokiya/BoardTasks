import type { ReactElement, ReactNode } from 'react';
import s from './controls.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  label: string;
  fullWidth?: boolean;
}

export function Segmented<T extends string>({ value, options, onChange, label, fullWidth }: SegmentedProps<T>): ReactElement {
  return (
    <div className={s.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={[s.segment, o.value === value ? s.segmentOn : '', fullWidth ? s.segmentFull : ''].filter(Boolean).join(' ')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
