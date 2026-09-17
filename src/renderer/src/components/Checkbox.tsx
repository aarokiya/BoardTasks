import { useId, type ReactElement, type ReactNode } from 'react';
import { IconCheck } from './icons';
import s from './controls.module.css';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
  id?: string;
}

export function Checkbox({ checked, onChange, label, hint, disabled, id }: CheckboxProps): ReactElement {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div>
      <label className={[s.check, disabled ? s.checkDisabled : ''].filter(Boolean).join(' ')} htmlFor={inputId}>
        <input
          id={inputId}
          type="checkbox"
          className={s.checkNative}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span className={[s.checkBox, checked ? s.checkOn : ''].filter(Boolean).join(' ')} aria-hidden="true">
          {checked ? <IconCheck size={11} strokeWidth={2.2} /> : null}
        </span>
        <span>{label}</span>
      </label>
      {hint ? <span className={s.checkHint}>{hint}</span> : null}
    </div>
  );
}
