import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '@shared/models';
import { formatDueWithTime } from '@shared/date/format';
import type { Row } from '../../store/selectors/views';
import { useStore } from '../../store/store';
import { cx } from '../../components/cx';
import { Tooltip } from '../../components/Tooltip';
import { IconAlert, IconChevronDown, IconCloud, IconFlag, IconNote } from '../../components/icons';
import { GithubChip } from '../github';
import { TaskCheckbox } from './TaskCheckbox';
import s from './TaskRow.module.css';

export interface SubCount { done: number; total: number }

export interface TaskRowProps {
  row: Row;
  task: Task;
  /** Show the owning list's name (smart views only). */
  showListName: boolean;
  subCount?: SubCount;
  /**
   * This row carries the tree's single tabIndex=0. It is the focused row when
   * there is one, and the first row otherwise — without it a freshly loaded
   * list has no tab stop at all.
   */
  tabbable: boolean;
  onToggleComplete: (task: Task, completed: boolean) => void;
  onPointerSelect: (e: ReactMouseEvent, id: string) => void;
  onRowKeyDown: (e: ReactKeyboardEvent, id: string) => void;
  onCommitTitle: (id: string, title: string, moveNext: boolean) => void;
  onOpen: (id: string) => void;
}

const PRIORITY_GLYPH: Record<number, string> = { 1: '!!!', 2: '!!', 3: '!' };
const PRIORITY_LABEL: Record<number, string> = { 1: 'High priority', 2: 'Medium priority', 3: 'Low priority' };

export function TaskRow({
  row, task, showListName, subCount, tabbable, onToggleComplete, onPointerSelect, onRowKeyDown, onCommitTitle, onOpen,
}: TaskRowProps): ReactElement {
  const selected = useStore((st) => st.selection.includes(task.id));
  const focused = useStore((st) => st.focusId === task.id);
  const editing = useStore((st) => st.editingId === task.id);
  const today = useStore((st) => st.today);
  const list = useStore((st) => st.lists[task.listId]);
  const toggleCollapsed = useStore((st) => st.toggleCollapsed);
  const setEditing = useStore((st) => st.setEditing);

  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { kind: 'task', depth: row.depth },
    disabled: editing,
  });
  // useSortable supplies role/tabIndex of its own; ours are authoritative here.
  const { role: _dndRole, tabIndex: _dndTabIndex, ...dragAttrs } = attributes;
  // The keyboard sensor's activator would shadow the row's own key handling
  // (Space completes, Enter opens), so it lives on a dedicated handle instead.
  const { onKeyDown: rawDragKeyDown, ...pointerListeners } = listeners ?? {};
  const dragKeyDown = rawDragKeyDown as ((e: ReactKeyboardEvent<HTMLButtonElement>) => void) | undefined;

  useEffect(() => {
    if (focused && !editing && document.activeElement !== rowRef.current) {
      const active = document.activeElement;
      const inField = active instanceof HTMLElement && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (!inField) rowRef.current?.focus({ preventScroll: true });
    }
  }, [focused, editing]);

  const completed = task.status === 'completed';
  const overdue = !completed && task.due !== null && task.due < today;
  const dueLabel = task.due ? formatDueWithTime(task.due, task.dueTime, today) : null;

  const nameParts = [task.title];
  if (dueLabel) nameParts.push(`due ${dueLabel}`);
  if (overdue) nameParts.push('Overdue');
  if (completed) nameParts.push('completed');
  if (task.priority > 0) nameParts.push(PRIORITY_LABEL[task.priority] ?? '');
  if (task.flagged) nameParts.push('flagged');
  if (subCount && subCount.total > 0) nameParts.push(`${subCount.done} of ${subCount.total} subtasks done`);
  if (showListName && list) nameParts.push(`in ${list.title}`);
  if (task.conflict) nameParts.push('has a sync conflict');
  else if (task.sync === 'failed') nameParts.push('failed to sync');

  const commit = (moveNext: boolean): void => {
    onCommitTitle(task.id, inputRef.current?.value ?? task.title, moveNext);
  };

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        rowRef.current = el;
      }}
      id={`bt-row-${task.id}`}
      data-testid="task-row"
      data-task-id={task.id}
      data-depth={row.depth}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.index + 1}
      aria-setsize={row.setSize}
      aria-selected={selected}
      aria-expanded={row.hasChildren ? !row.collapsed : undefined}
      aria-label={nameParts.filter(Boolean).join(', ')}
      tabIndex={tabbable ? 0 : -1}
      className={cx(
        s.row,
        row.depth === 1 && s.depth1,
        selected && s.rowSelected,
        selected && focused && s.rowFocusedSelected,
        completed && s.rowCompleted,
        isDragging && s.rowDragging,
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onMouseDown={(e) => onPointerSelect(e, task.id)}
      onDoubleClick={(e) => {
        e.preventDefault();
        setEditing(task.id);
      }}
      onKeyDown={(e) => {
        if (editing) return;
        onRowKeyDown(e, task.id);
      }}
      {...pointerListeners}
    >
      {row.depth === 1 ? <span className={s.guide} aria-hidden="true" /> : null}

      <button
        type="button"
        className="sr-only"
        tabIndex={tabbable ? 0 : -1}
        aria-label={`Reorder ${task.title}`}
        onKeyDown={dragKeyDown}
        {...dragAttrs}
      />

      {row.hasChildren ? (
        <button
          type="button"
          className={cx(s.disclosure, !row.collapsed && s.disclosureOpen, row.collapsed && s.disclosureCollapsed)}
          aria-label={row.collapsed ? `Expand subtasks of ${task.title}` : `Collapse subtasks of ${task.title}`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapsed(task.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className={s.disclosureChevron}><IconChevronDown size={12} /></span>
        </button>
      ) : null}

      <TaskCheckbox task={task} onToggle={(v) => onToggleComplete(task, v)} />

      {editing ? (
        <input
          ref={inputRef}
          className={s.titleInput}
          defaultValue={task.title}
          autoFocus
          aria-label={`Edit title of ${task.title}`}
          onFocus={(e) => e.currentTarget.select()}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => commit(false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(true); }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
          }}
        />
      ) : (
        <span className={s.title} onClick={() => onOpen(task.id)}>{task.title}</span>
      )}

      {editing ? null : (
        <span className={s.meta}>
          {task.github ? <GithubChip link={task.github} compact /> : null}
          {task.notes.trim() ? (
            <span className={s.noteMark} title="Has notes" aria-hidden="true"><IconNote size={13} /></span>
          ) : null}
          {subCount && subCount.total > 0 ? (
            <span className={s.subCount} aria-hidden="true">{subCount.done}/{subCount.total}</span>
          ) : null}
          {task.priority > 0 ? (
            <span className={cx(s.priority, s[`priority${task.priority}`])} aria-hidden="true">
              {PRIORITY_GLYPH[task.priority]}
            </span>
          ) : null}
          {task.flagged ? <span className={s.flag} aria-hidden="true"><IconFlag size={13} /></span> : null}
          {dueLabel ? (
            <span className={cx(s.due, overdue && s.dueOverdue, !overdue && task.due === today && s.dueToday)} aria-hidden="true">
              {dueLabel}
            </span>
          ) : null}
          {showListName && list ? (
            <span className={s.listName} aria-hidden="true">
              <span className={s.listDot} style={{ background: `var(--bt-list-${list.color})` }} />
              {list.title}
            </span>
          ) : null}
          {task.conflict ? (
            <Tooltip label="Edited on another device too — open the inspector to resolve">
              <span className={cx(s.syncGlyph, s.syncConflict)} aria-hidden="true"><IconAlert size={13} /></span>
            </Tooltip>
          ) : task.sync === 'failed' ? (
            <Tooltip label="This change didn't reach Google — review unsynced changes">
              <span className={cx(s.syncGlyph, s.syncFailed)} aria-hidden="true"><IconAlert size={13} /></span>
            </Tooltip>
          ) : task.sync === 'pending' ? (
            <Tooltip label="Waiting to sync">
              <span className={s.syncGlyph} aria-hidden="true"><IconCloud size={13} /></span>
            </Tooltip>
          ) : null}
        </span>
      )}
    </div>
  );
}
