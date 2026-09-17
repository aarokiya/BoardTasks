import { useMemo, type ReactElement } from 'react';
import type { Task } from '@shared/models';
import type { CivilDate } from '@shared/date/civil';
import { formatDueWithTime } from '@shared/date/format';
import { announce } from '../../lib/announce';
import { useStore } from '../../store/store';
import { Dialog } from '../../components/Dialog';
import { DatePickerBody } from './DatePickerPopover';
import { ListPickerBody } from './ListPickerPopover';
import s from './DetailPane.module.css';

interface TaskIdsPayload {
  taskIds: string[];
}

function readTaskIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const ids = (payload as Partial<TaskIdsPayload>).taskIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}

/** Tasks that still exist, in payload order. */
function useTasks(ids: string[]): Task[] {
  const version = useStore((st) => st.version);
  return useMemo(() => {
    void version;
    const all = useStore.getState().tasks;
    return ids.map((id) => all[id]).filter((t): t is Task => t !== undefined);
  }, [ids, version]);
}

/** One value if every task agrees, otherwise null. */
function common<T>(tasks: Task[], read: (t: Task) => T): T | null {
  if (tasks.length === 0) return null;
  const first = read(tasks[0]!);
  return tasks.every((t) => read(t) === first) ? first : null;
}

function reportFailure(e: unknown, fallback: string): void {
  const message = e instanceof Error ? e.message : fallback;
  announce(message, 'assertive');
  useStore.getState().toast({ level: 'error', message });
}

/* ─────────────────────────── date picker ─────────────────────────────── */

/** Bulk due-date overlay. `store.overlayPayload` is `{ taskIds }`. */
export function DatePickerOverlay(): ReactElement | null {
  const overlay = useStore((st) => st.overlay);
  const payload = useStore((st) => st.overlayPayload);
  const today = useStore((st) => st.today);
  const closeOverlay = useStore((st) => st.closeOverlay);
  const ids = useMemo(() => readTaskIds(payload), [payload]);
  const tasks = useTasks(ids);

  if (overlay !== 'date-picker') return null;

  const apply = (due: CivilDate | null, dueTime: string | null): void => {
    const store = useStore.getState();
    const label = due ? formatDueWithTime(due, dueTime, today) : 'no due date';
    announce(tasks.length === 1 ? `Due ${label}` : `Set ${label} for ${tasks.length} tasks`);
    void Promise.all(tasks.map((t) => store.updateTask(t.id, { due, dueTime })))
      .then(() => {
        store.toast({
          level: 'success',
          message: tasks.length === 1 ? `Due ${label}` : `${tasks.length} tasks due ${label}`,
        });
      })
      .catch((e: unknown) => reportFailure(e, 'Could not set that due date.'));
  };

  const title = tasks.length === 1 ? 'Set due date' : `Set due date · ${tasks.length} tasks`;

  return (
    <Dialog open onClose={closeOverlay} title={title} alignTop flushBody description="Choose a due date for the selected tasks.">
      {tasks.length === 0 ? (
        <div className={s.overlayBody}>
          <p className={s.overlayNote}>Those tasks are no longer available.</p>
        </div>
      ) : (
        <DatePickerBody
          due={common(tasks, (t) => t.due)}
          dueTime={common(tasks, (t) => t.dueTime)}
          today={today}
          onChange={apply}
          onDone={closeOverlay}
        />
      )}
    </Dialog>
  );
}

/* ─────────────────────────── list picker ─────────────────────────────── */

/** Bulk "move to list" overlay. `store.overlayPayload` is `{ taskIds }`. */
export function ListPickerOverlay(): ReactElement | null {
  const overlay = useStore((st) => st.overlay);
  const payload = useStore((st) => st.overlayPayload);
  const closeOverlay = useStore((st) => st.closeOverlay);
  const ids = useMemo(() => readTaskIds(payload), [payload]);
  const tasks = useTasks(ids);

  if (overlay !== 'list-picker') return null;

  const apply = (listId: string): void => {
    const store = useStore.getState();
    const name = store.lists[listId]?.title ?? 'list';
    announce(tasks.length === 1 ? `Moved to ${name}` : `Moved ${tasks.length} tasks to ${name}`);
    void Promise.all(tasks.map((t) => store.moveTask({ id: t.id, listId, parentId: null, previousId: 'end' })))
      .then(() => {
        store.toast({
          level: 'success',
          message: tasks.length === 1 ? `Moved to ${name}` : `Moved ${tasks.length} tasks to ${name}`,
        });
      })
      .catch((e: unknown) => reportFailure(e, 'Could not move those tasks.'));
  };

  const title = tasks.length === 1 ? 'Move to list' : `Move ${tasks.length} tasks`;

  return (
    <Dialog open onClose={closeOverlay} title={title} alignTop flushBody description="Choose the list to move the selected tasks into.">
      {tasks.length === 0 ? (
        <div className={s.overlayBody}>
          <p className={s.overlayNote}>Those tasks are no longer available.</p>
        </div>
      ) : (
        <ListPickerBody value={common(tasks, (t) => t.listId)} onChange={apply} onDone={closeOverlay} />
      )}
    </Dialog>
  );
}
