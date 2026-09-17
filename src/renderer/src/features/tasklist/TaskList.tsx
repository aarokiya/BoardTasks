import { useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Task } from '@shared/models';
import { useStore } from '../../store/store';
import { selectRows, type Row } from '../../store/selectors/views';
import { isCommandEnabled, runCommand } from '../../commands/registry';
import { announce } from '../../lib/announce';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { RowBoundary } from '../../components/ErrorBoundary';
import { useTaskDnd } from '../dnd/dndState';
import { INDENT_WIDTH } from '../dnd/projection';
import { GroupHeader } from './GroupHeader';
import { ViewEmptyState } from './EmptyViews';
import { TaskRow, type SubCount } from './TaskRow';
import { VirtualRows } from './VirtualRows';
import s from './TaskList.module.css';

const VIRTUALIZE_ABOVE = 200;
const MAX_ANIMATED_EXITS = 15;
const EXIT_MS = 220;
const ROW_HEIGHT = { compact: 30, default: 36, comfortable: 44 };

interface Ghost { row: Row; task: Task; index: number }

export function TaskList(): ReactElement {
  const rows = useStore(selectRows);
  const tasks = useStore((st) => st.tasks);
  const view = useStore((st) => st.view);
  const density = useStore((st) => st.density);
  const anchorId = useStore((st) => st.anchorId);
  const showCompletedByList = useStore((st) => st.showCompletedByList);
  const select = useStore((st) => st.select);
  const setFocus = useStore((st) => st.setFocus);
  const setEditing = useStore((st) => st.setEditing);
  const setUi = useStore((st) => st.setUi);
  const setStatus = useStore((st) => st.setStatus);
  const updateTask = useStore((st) => st.updateTask);
  const toast = useStore((st) => st.toast);

  const dnd = useTaskDnd();
  const reduced = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, true>>({});
  const [ghosts, setGhosts] = useState<Ghost[]>([]);

  const listId = view.startsWith('list:') ? view.slice(5) : null;
  const showListName = listId === null && view !== 'github';

  const subCounts = useMemo(() => {
    const m: Record<string, SubCount> = {};
    for (const t of Object.values(tasks)) {
      if (!t.parentId) continue;
      const cur = m[t.parentId] ?? { done: 0, total: 0 };
      cur.total += 1;
      if (t.status === 'completed') cur.done += 1;
      m[t.parentId] = cur;
    }
    return m;
  }, [tasks]);

  /** Rows with collapsed groups hidden. */
  const displayRows = useMemo(() => {
    const out: Row[] = [];
    let hiding = false;
    for (const r of rows) {
      if (r.kind === 'group') {
        hiding = collapsedGroups[r.id] === true;
        out.push(r);
        continue;
      }
      if (!hiding) out.push(r);
    }
    return out;
  }, [rows, collapsedGroups]);

  const taskRows = useMemo(() => displayRows.filter((r) => r.kind === 'task'), [displayRows]);
  const sortableIds = useMemo(() => taskRows.map((r) => r.id), [taskRows]);

  const focusRow = useCallback(
    (id: string) => {
      setFocus(id);
      document.getElementById(`bt-row-${id}`)?.scrollIntoView({ block: 'nearest' });
    },
    [setFocus],
  );

  const rangeSelect = useCallback(
    (from: string, to: string) => {
      const a = taskRows.findIndex((r) => r.id === from);
      const b = taskRows.findIndex((r) => r.id === to);
      if (a < 0 || b < 0) {
        select([to], to);
        return;
      }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      select(taskRows.slice(lo, hi + 1).map((r) => r.id), from);
      setFocus(to);
    },
    [taskRows, select, setFocus],
  );

  const onPointerSelect = useCallback(
    (e: ReactMouseEvent, id: string) => {
      if (e.button !== 0) return;
      if (e.shiftKey && anchorId) {
        e.preventDefault();
        rangeSelect(anchorId, id);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const cur = useStore.getState().selection;
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        select(next, anchorId ?? id);
        setFocus(id);
        return;
      }
      select([id], id);
      setFocus(id);
    },
    [anchorId, rangeSelect, select, setFocus],
  );

  /** True when completing a task removes it from the view we're looking at. */
  const completionLeavesView = view !== 'completed' && (listId ? !(showCompletedByList[listId] ?? false) : true);

  const beginExit = useCallback(
    (task: Task) => {
      if (reduced) return;
      const index = displayRows.findIndex((r) => r.id === task.id);
      const row = displayRows[index];
      if (!row || displayRows.length > VIRTUALIZE_ABOVE) return;
      setGhosts((g) => {
        if (g.length >= MAX_ANIMATED_EXITS) return g;
        return [...g, { row, task, index }];
      });
      setTimeout(() => setGhosts((g) => g.filter((x) => x.row.id !== row.id)), EXIT_MS + 20);
    },
    [displayRows, reduced],
  );

  const onToggleComplete = useCallback(
    (task: Task, completed: boolean) => {
      if (completed && completionLeavesView) beginExit(task);
      announce(`${task.title} ${completed ? 'completed' : 'marked not completed'}`);
      void setStatus([task.id], completed).catch(() => toast({ level: 'error', message: `Couldn't update "${task.title}".` }));
    },
    [completionLeavesView, beginExit, setStatus, toast],
  );

  const onCommitTitle = useCallback(
    (id: string, title: string, moveNext: boolean) => {
      const task = useStore.getState().tasks[id];
      setEditing(null);
      const trimmed = title.trim();
      if (task && trimmed && trimmed !== task.title) {
        announce(`Renamed to ${trimmed}`);
        void updateTask(id, { title: trimmed }).catch(() => toast({ level: 'error', message: "Couldn't save that title." }));
      }
      if (moveNext) {
        const i = taskRows.findIndex((r) => r.id === id);
        const next = taskRows[i + 1];
        if (next) focusRow(next.id);
        else document.getElementById(`bt-row-${id}`)?.focus();
      } else {
        document.getElementById(`bt-row-${id}`)?.focus();
      }
    },
    [setEditing, updateTask, toast, taskRows, focusRow],
  );

  const onOpen = useCallback(
    (id: string) => {
      setUi({ inspectorOpen: true });
      setFocus(id);
    },
    [setUi, setFocus],
  );

  const move = useCallback(
    (delta: number, extend: boolean) => {
      const cur = useStore.getState().focusId;
      const i = taskRows.findIndex((r) => r.id === cur);
      const target = taskRows[Math.min(taskRows.length - 1, Math.max(0, (i < 0 ? (delta > 0 ? -1 : taskRows.length) : i) + delta))];
      if (!target) return;
      if (extend) rangeSelect(anchorId ?? cur ?? target.id, target.id);
      else select([target.id], target.id);
      focusRow(target.id);
    },
    [taskRows, anchorId, rangeSelect, select, focusRow],
  );

  const onRowKeyDown = useCallback(
    (e: ReactKeyboardEvent, id: string) => {
      const task = useStore.getState().tasks[id];
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          move(1, e.shiftKey);
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          move(-1, e.shiftKey);
          break;
        case 'Home':
          e.preventDefault();
          if (taskRows[0]) { select([taskRows[0].id], taskRows[0].id); focusRow(taskRows[0].id); }
          break;
        case 'End': {
          e.preventDefault();
          const last = taskRows[taskRows.length - 1];
          if (last) { select([last.id], last.id); focusRow(last.id); }
          break;
        }
        case ' ':
          e.preventDefault();
          e.stopPropagation();
          if (isCommandEnabled('task.complete')) void runCommand('task.complete');
          else if (task) onToggleComplete(task, task.status !== 'completed');
          break;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          onOpen(id);
          break;
        case 'e':
        case 'E':
          e.preventDefault();
          e.stopPropagation();
          setEditing(id);
          break;
        case 'Escape':
          e.preventDefault();
          select([]);
          break;
        default:
          break;
      }
    },
    [move, taskRows, select, focusRow, onToggleComplete, onOpen, setEditing],
  );

  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups((g) => {
      const next = { ...g };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }, []);

  const renderRow = useCallback(
    (row: Row): ReactNode => {
      if (row.kind === 'group') {
        return (
          <GroupHeader
            id={row.id}
            label={row.label ?? ''}
            count={row.count ?? 0}
            collapsed={collapsedGroups[row.id] === true}
            onToggle={toggleGroup}
          />
        );
      }
      const task = row.task;
      if (!task) return null;
      const indicator = dnd.indicatorRowId === row.id && dnd.projection;
      return (
        <div className={s.rowWrap}>
          {indicator && dnd.projection ? (
            <span className={s.dropLine} style={{ left: dnd.projection.depth * INDENT_WIDTH, top: -1 }} aria-hidden="true" />
          ) : null}
          <RowBoundary rowText={task.title}>
            <TaskRow
              row={row}
              task={task}
              showListName={showListName}
              subCount={subCounts[task.id]}
              onToggleComplete={onToggleComplete}
              onPointerSelect={onPointerSelect}
              onRowKeyDown={onRowKeyDown}
              onCommitTitle={onCommitTitle}
              onOpen={onOpen}
            />
          </RowBoundary>
        </div>
      );
    },
    [collapsedGroups, toggleGroup, dnd.indicatorRowId, dnd.projection, showListName, subCounts, onToggleComplete, onPointerSelect, onRowKeyDown, onCommitTitle, onOpen],
  );

  const filterQuery = useStore((st) => st.filterQuery);
  const rowHeight = ROW_HEIGHT[density];
  const virtualize = displayRows.length > VIRTUALIZE_ABOVE;

  /** Ghost rows spliced back in at their old index for the 220ms collapse. */
  interface Entry { row: Row; ghostTitle: string | null }
  const withGhosts = useMemo((): Entry[] => {
    const out: Entry[] = displayRows.map((row) => ({ row, ghostTitle: null }));
    for (const g of ghosts) out.splice(Math.min(g.index, out.length), 0, { row: g.row, ghostTitle: g.task.title });
    return out;
  }, [displayRows, ghosts]);

  return (
    <div ref={scrollRef} className={s.scroller} data-density={density} data-testid="task-scroller">
      {withGhosts.length === 0 ? <ViewEmptyState view={view} filtered={filterQuery.trim().length > 0} /> : null}
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className={s.tree} role="tree" aria-label="Tasks" aria-multiselectable="true">
          {virtualize ? (
            <VirtualRows rows={displayRows} scrollRef={scrollRef} rowHeight={rowHeight} renderRow={(row) => renderRow(row)} />
          ) : (
            withGhosts.map((entry, i) =>
              entry.ghostTitle !== null ? (
                <div key={`ghost-${entry.row.id}`} className={s.ghost} aria-hidden="true">
                  <div className={s.ghostRow}>{entry.ghostTitle}</div>
                </div>
              ) : (
                <div key={`${entry.row.id}-${i}`}>{renderRow(entry.row)}</div>
              ),
            )
          )}
        </div>
      </SortableContext>
    </div>
  );
}
