import type { ReactElement } from 'react';
import s from './controls.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, disabled, id }: SwitchProps): ReactElement {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={[s.switch, checked ? s.switchOn : ''].filter(Boolean).join(' ')}
      onClick={() => onChange(!checked)}
    >
      <span className={s.switchKnob} />
    </button>
  );
}
