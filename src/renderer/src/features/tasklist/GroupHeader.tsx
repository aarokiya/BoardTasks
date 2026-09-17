import type { ReactElement } from 'react';
import { cx } from '../../components/cx';
import { IconChevronDown } from '../../components/icons';
import s from './TaskList.module.css';

export interface GroupHeaderProps {
  id: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: (id: string) => void;
}

export function GroupHeader({ id, label, count, collapsed, onToggle }: GroupHeaderProps): ReactElement {
  return (
    <button
      type="button"
      className={cx(s.groupHeader, label === 'Overdue' && s.groupHeaderOverdue)}
      aria-expanded={!collapsed}
      aria-label={`${label}, ${count} task${count === 1 ? '' : 's'}`}
      onClick={() => onToggle(id)}
    >
      <span className={cx(s.groupChevron, collapsed && s.groupChevronCollapsed)} aria-hidden="true">
        <IconChevronDown size={11} />
      </span>
      <span>{label}</span>
      <span className={s.groupCount} aria-hidden="true">{count}</span>
    </button>
  );
}
