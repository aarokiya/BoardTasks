import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import type { Task } from '@shared/models';
import { cx } from '../../components/cx';
import s from './TaskRow.module.css';

export interface TaskCheckboxProps {
  task: Task;
  onToggle: (completed: boolean) => void;
}

/** 16px custom checkbox with a spring scale and a drawn checkmark; 28px hit target. */
export function TaskCheckbox({ task, onToggle }: TaskCheckboxProps): ReactElement {
  const completed = task.status === 'completed';
  return (
    <span
      role="checkbox"
      aria-checked={completed}
      aria-label={`${task.title}, ${completed ? 'completed' : 'not completed'}`}
      tabIndex={-1}
      className={s.checkHit}
      onClick={(e: ReactMouseEvent) => {
        e.stopPropagation();
        onToggle(!completed);
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          onToggle(!completed);
        }
      }}
    >
      <span className={cx(s.checkbox, completed && s.checkboxOn, !completed && task.priority === 1 && s.checkP1)} aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" focusable="false">
          <path className={s.checkMark} d="M2 6.2 4.6 8.8 10 3.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
  );
}
