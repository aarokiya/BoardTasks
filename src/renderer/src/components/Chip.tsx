import type { ReactElement, ReactNode } from 'react';
import s from './controls.module.css';

export type ChipTone = 'neutral' | 'accent' | 'danger' | 'warning' | 'success';

export interface ChipProps {
  tone?: ChipTone;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  onClick?: () => void;
  className?: string;
}

const toneClass: Record<ChipTone, string> = {
  neutral: '', accent: s.chipAccent!, danger: s.chipDanger!, warning: s.chipWarning!, success: s.chipSuccess!,
};

export function Chip({ tone = 'neutral', icon, children, title, onClick, className }: ChipProps): ReactElement {
  const cls = [s.chip, toneClass[tone], onClick ? s.chipButton : '', className ?? ''].filter(Boolean).join(' ');
  if (onClick) {
    return (
      <button type="button" className={cls} title={title} onClick={onClick}>
        {icon}
        {children}
      </button>
    );
  }
  return (
    <span className={cls} title={title}>
      {icon}
      {children}
    </span>
  );
}
