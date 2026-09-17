import { forwardRef, useId, type InputHTMLAttributes, type ReactElement } from 'react';
import s from './controls.module.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
  inputSize?: 'md' | 'lg';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, mono, inputSize = 'md', className, id, ...rest },
  ref,
): ReactElement {
  const auto = useId();
  const inputId = id ?? auto;
  const describedBy = error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined;
  const cls = [s.input, inputSize === 'lg' ? s.inputLg : '', mono ? s.inputMono : '', error ? s.inputInvalid : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={s.field}>
      {label ? (
        <label className={s.fieldLabel} htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input id={inputId} ref={ref} className={cls} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
      {error ? (
        <span id={`${inputId}-err`} className={s.fieldError}>
          {error}
        </span>
      ) : hint ? (
        <span id={`${inputId}-hint`} className={s.fieldHint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
});
