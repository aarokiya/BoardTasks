import { useCallback, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { PREVIOUS_END } from '@shared/models';
import { useStore } from '../../store/store';
import { selectLists, selectRows } from '../../store/selectors/views';
import { announce } from '../../lib/announce';
import { call } from '../../lib/ipc';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { IconGrip } from '../../components/icons';
import { TaskDndContext, type TaskDndState } from './dndState';
import { INDENT_WIDTH, projectDrop, type FlatItem } from './projection';
import s from '../tasklist/TaskList.module.css';

const LIST_DROP = 'listdrop:';
const LIST_ROW = 'listrow:';

const collisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  return pointer.length > 0 ? pointer : closestCenter(args);
};

export function TaskDndProvider({ children }: { children: ReactNode }): ReactElement {
  const rows = useStore(selectRows);
  const tasks = useStore((st) => st.tasks);
  const lists = useStore(selectLists);
  const setDragging = useStore((st) => st.setDragging);
  const moveTask = useStore((st) => st.moveTask);
  const applyEvent = useStore((st) => st.applyEvent);
  const toast = useStore((st) => st.toast);
  const selection = useStore((st) => st.selection);
  const reduced = useReducedMotion();

  const [state, setState] = useState<TaskDndState>({ activeTaskId: null, projection: null, indicatorRowId: null, overListId: null });
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const offsetX = useRef(0);

  const items: FlatItem[] = useMemo(
    () => rows.filter((r) => r.kind === 'task').map((r) => ({ id: r.id, depth: r.depth, hasChildren: r.hasChildren ?? false })),
    [rows],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = useCallback(
    (e: DragStartEvent) => {
      const id = String(e.active.id);
      setDragging(true);
      offsetX.current = 0;
      if (id.startsWith(LIST_ROW)) {
        setActiveListId(id.slice(LIST_ROW.length));
        return;
      }
      setState({ activeTaskId: id, projection: null, indicatorRowId: null, overListId: null });
    },
    [setDragging],
  );

  const onDragMove = useCallback(
    (e: DragMoveEvent) => {
      offsetX.current = e.delta.x;
      const overId = e.over ? String(e.over.id) : null;
      setState((prev) => {
        if (!prev.activeTaskId) return prev;
        if (overId && overId.startsWith(LIST_DROP)) {
          return { ...prev, projection: null, indicatorRowId: null, overListId: overId.slice(LIST_DROP.length) };
        }
        const activeId = prev.activeTaskId;
        const projection = overId ? projectDrop(items, activeId, overId, e.delta.x, INDENT_WIDTH) : null;
        return { ...prev, projection, indicatorRowId: projection ? overId : null, overListId: null };
      });
    },
    [items],
  );

  const onDragOver = useCallback(
    (e: DragOverEvent) => {
      const overId = e.over ? String(e.over.id) : null;
      setState((prev) => {
        if (!prev.activeTaskId) return prev;
        if (overId && overId.startsWith(LIST_DROP)) return { ...prev, overListId: overId.slice(LIST_DROP.length), projection: null, indicatorRowId: null };
        return prev.overListId === null ? prev : { ...prev, overListId: null };
      });
    },
    [],
  );

  const reset = useCallback(() => {
    setState({ activeTaskId: null, projection: null, indicatorRowId: null, overListId: null });
    setActiveListId(null);
    offsetX.current = 0;
    setDragging(false);
  }, [setDragging]);

  const reorderLists = useCallback(
    async (activeId: string, overId: string) => {
      const from = lists.findIndex((l) => l.id === activeId);
      const to = lists.findIndex((l) => l.id === overId);
      if (from < 0 || to < 0 || from === to) return;
      const next = arrayMove(lists, from, to).map((l, i) => ({ ...l, position: i }));
      applyEvent({ type: 'data:changed', reason: 'local', tasks: [], lists: next, deletedTaskIds: [], deletedListIds: [] });
      announce(`${lists[from]?.title ?? 'List'} moved to position ${to + 1}`);
      try {
        const saved = await call('lists:reorder', { orderedIds: next.map((l) => l.id) });
        applyEvent({ type: 'data:changed', reason: 'local', tasks: [], lists: saved, deletedTaskIds: [], deletedListIds: [] });
      } catch {
        toast({ level: 'error', message: "Couldn't save the new list order." });
      }
    },
    [lists, applyEvent, toast],
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const activeId = String(e.active.id);
      const overId = e.over ? String(e.over.id) : null;
      const projection = state.projection;
      const overListId = state.overListId;
      reset();
      if (!overId) return;

      if (activeId.startsWith(LIST_ROW)) {
        if (!overId.startsWith(LIST_ROW)) return;
        void reorderLists(activeId.slice(LIST_ROW.length), overId.slice(LIST_ROW.length));
        return;
      }

      const task = tasks[activeId];
      if (!task) return;

      if (overId.startsWith(LIST_DROP) || overListId) {
        const listId = overListId ?? overId.slice(LIST_DROP.length);
        if (listId === task.listId) return;
        const listTitle = lists.find((l) => l.id === listId)?.title ?? 'list';
        announce(`${task.title} moved to ${listTitle}`);
        void moveTask({ id: activeId, listId, parentId: null, previousId: PREVIOUS_END }).catch(() =>
          toast({ level: 'error', message: `Couldn't move "${task.title}" to ${listTitle}.` }),
        );
        return;
      }

      if (!projection || overId === activeId) return;
      announce(`${task.title} moved${projection.depth === 1 ? ' as a subtask' : ''}`);
      void moveTask({ id: activeId, parentId: projection.parentId, previousId: projection.previousId }).catch(() =>
        toast({ level: 'error', message: `Couldn't move "${task.title}".` }),
      );
    },
    [state.projection, state.overListId, reset, reorderLists, tasks, lists, moveTask, toast],
  );

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart: ({ active }) => {
        const id = String(active.id);
        const t = tasks[id];
        return t ? `Picked up ${t.title}. Use the arrow keys to move it, space to drop, escape to cancel.` : 'Picked up list.';
      },
      onDragOver: ({ active, over }) => {
        const t = tasks[String(active.id)];
        if (!over) return 'No drop target.';
        const overTask = tasks[String(over.id)];
        if (overTask) return `${t?.title ?? 'Item'} is over ${overTask.title}.`;
        const listId = String(over.id).startsWith(LIST_DROP) ? String(over.id).slice(LIST_DROP.length) : null;
        const listTitle = listId ? lists.find((l) => l.id === listId)?.title : null;
        return listTitle ? `${t?.title ?? 'Item'} is over the list ${listTitle}.` : 'Moving.';
      },
      onDragEnd: ({ active, over }) => {
        const t = tasks[String(active.id)];
        return over ? `${t?.title ?? 'Item'} dropped.` : `${t?.title ?? 'Item'} returned to its original position.`;
      },
      onDragCancel: ({ active }) => `Moving ${tasks[String(active.id)]?.title ?? 'item'} was cancelled.`,
    }),
    [tasks, lists],
  );

  const activeTask = state.activeTaskId ? tasks[state.activeTaskId] : null;
  const activeList = activeListId ? lists.find((l) => l.id === activeListId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      accessibility={{ announcements }}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <TaskDndContext value={state}>{children}</TaskDndContext>
      <DragOverlay dropAnimation={reduced ? null : undefined}>
        {activeTask ? (
          <div className={s.dragPreview}>
            <IconGrip size={14} />
            <span>{activeTask.title}</span>
            {selection.length > 1 && selection.includes(activeTask.id) ? (
              <span className={s.dragCount}>{selection.length}</span>
            ) : null}
          </div>
        ) : activeList ? (
          <div className={s.dragPreview}>
            <span className={s.dragCount} style={{ background: `var(--bt-list-${activeList.color})` }}>&nbsp;</span>
            <span>{activeList.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
