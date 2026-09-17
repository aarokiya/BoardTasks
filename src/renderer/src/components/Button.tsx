import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import s from './controls.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  fullWidth?: boolean;
  type?: 'button' | 'submit';
}

const sizeClass: Record<ButtonSize, string> = { sm: s.sizeSm!, md: s.sizeMd!, lg: s.sizeLg! };
const variantClass: Record<ButtonVariant, string> = { primary: s.primary!, secondary: s.secondary!, ghost: s.ghost!, danger: s.danger! };

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  fullWidth,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): ReactElement {
  const cls = [s.btn, sizeClass[size], variantClass[variant], fullWidth ? s.full : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}
