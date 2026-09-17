import type { ReactElement, ReactNode } from 'react';
import s from './feedback.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ icon, title, body, actions }: EmptyStateProps): ReactElement {
  return (
    <div className={s.empty}>
      {icon ? <div className={s.emptyIcon} aria-hidden="true">{icon}</div> : null}
      <div className={s.emptyTitle}>{title}</div>
      {body ? <div className={s.emptyBody}>{body}</div> : null}
      {actions ? <div className={s.emptyActions}>{actions}</div> : null}
    </div>
  );
}
