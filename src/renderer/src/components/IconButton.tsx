import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import s from './controls.module.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  /** Required: icon-only controls must have an accessible name. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
  danger?: boolean;
}

const sizeClass = { sm: s.iconSm!, md: s.iconMd!, lg: s.iconLg! };

export function IconButton({ label, icon, size = 'md', active, danger, className, ...rest }: IconButtonProps): ReactElement {
  const cls = [s.iconBtn, sizeClass[size], active ? s.iconActive : '', danger ? s.iconDanger : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  );
}
