import type { Priority, Task } from '@shared/models';
import { PREVIOUS_END } from '@shared/models';
import { addDays, nextWeekday, type CivilDate } from '@shared/date/civil';
import { formatRelative } from '@shared/date/format';
import { announce } from '../../lib/announce';
import { recordUndoable, runUndoable } from '../../features/undo';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import type { CommandContext, CommandImpl } from '../registry';
import type { CommandId } from '../ids';
import { copyText, hasChildren, hasTarget, patchTargets, plural, previousTopSibling, siblingsOf, targetIds, targetTasks } from './helpers';

const firstTarget = (ctx: CommandContext): Task | null => targetTasks(ctx)[0] ?? null;

/** "This weekend" = the upcoming Saturday (today, if today is Saturday). */
export const weekendDate = (today: CivilDate): CivilDate => nextWeekday(today, 6, true);
/** "Next week" = the coming Monday. */
export const nextWeekDate = (today: CivilDate): CivilDate => nextWeekday(today, 1);

function dueCommand(label: string, compute: (today: CivilDate) => CivilDate | null): CommandImpl {
  return {
    enabled: hasTarget,
    run: async (ctx) => {
      const due = compute(useStore.getState().today);
      const n = targetTasks(ctx).length;
      await patchTargets(ctx, { due }, `${label} for ${plural(n, 'task')}`, due ? `Due ${formatRelative(due, useStore.getState().today)}` : 'Due date cleared');
    },
  };
}

export const taskCommands: Partial<Record<CommandId, CommandImpl>> = {
  'task.complete': {
    enabled: hasTarget,
    run: async (ctx) => {
      const tasks = targetTasks(ctx);
      if (tasks.length === 0) return;
      const allDone = tasks.every((t) => t.status === 'completed');
      const completed = !allDone;
      const ids = tasks.map((t) => t.id);
      const apply = async (): Promise<void> => {
        await useStore.getState().setStatus(ids, completed).catch(() => null);
      };
      const revert = async (): Promise<void> => {
        await Promise.all(
          tasks.map((t) => useStore.getState().setStatus([t.id], t.status === 'completed').catch(() => null)),
        );
      };
      await runUndoable({ label: completed ? `Complete ${plural(ids.length, 'task')}` : `Reopen ${plural(ids.length, 'task')}`, apply, revert });
      announce(completed ? `Completed ${plural(ids.length, 'task')}` : `Reopened ${plural(ids.length, 'task')}`);
    },
  },

  'task.rename': {
    enabled: (ctx) => !!ctx.focusId && !!useStore.getState().tasks[ctx.focusId],
    run: (ctx) => {
      if (ctx.focusId) useStore.getState().setEditing(ctx.focusId);
    },
  },

  'task.delete': {
    enabled: hasTarget,
    run: async (ctx) => {
      const tasks = targetTasks(ctx);
      if (tasks.length === 0) return;
      const ids = tasks.map((t) => t.id);
      const label = `Delete ${plural(ids.length, 'task')}`;
      const apply = async (): Promise<void> => {
        await useStore.getState().deleteTasks(ids).catch(() => null);
      };
      const revert = async (): Promise<void> => {
        await useStore.getState().restoreTasks(ids).catch(() => null);
      };
      await runUndoable({ label, apply, revert });
      const store = useStore.getState();
      store.toast({
        level: 'info',
        message: ids.length === 1 ? `Deleted “${tasks[0]!.title || 'Untitled'}”` : `Deleted ${plural(ids.length, 'task')}`,
        actionLabel: 'Undo',
        onAction: () => void useStore.getState().undo(),
      });
      announce(`${label} — press Command Z to undo`);
    },
  },

  'task.due.today': dueCommand('Due today', (t) => t),
  'task.due.tomorrow': dueCommand('Due tomorrow', (t) => addDays(t, 1)),
  'task.due.weekend': dueCommand('Due this weekend', weekendDate),
  'task.due.nextweek': dueCommand('Due next week', nextWeekDate),
  'task.due.clear': {
    enabled: hasTarget,
    run: async (ctx) => {
      const n = targetTasks(ctx).length;
      await patchTargets(ctx, { due: null, dueTime: null }, `Clear due date on ${plural(n, 'task')}`, 'Due date cleared');
    },
  },
  'task.due.pick': {
    enabled: hasTarget,
    run: (ctx) => {
      useStore.getState().openOverlay('date-picker', { taskIds: targetIds(ctx) });
    },
  },
  'task.time.pick': {
    enabled: hasTarget,
    run: (ctx) => {
      useStore.getState().openOverlay('time-picker', { taskIds: targetIds(ctx) });
    },
  },

  'task.priority.0': priorityCommand(0),
  'task.priority.1': priorityCommand(1),
  'task.priority.2': priorityCommand(2),
  'task.priority.3': priorityCommand(3),

  'task.flag': {
    enabled: hasTarget,
    run: async (ctx) => {
      const tasks = targetTasks(ctx);
      if (tasks.length === 0) return;
      const flagged = !tasks.every((t) => t.flagged);
      await patchTargets(ctx, { flagged }, `${flagged ? 'Flag' : 'Unflag'} ${plural(tasks.length, 'task')}`, flagged ? 'Flagged' : 'Unflagged');
    },
  },

  'task.move': {
    enabled: hasTarget,
    run: (ctx) => {
      useStore.getState().openOverlay('list-picker', { taskIds: targetIds(ctx) });
    },
  },

  'task.indent': {
    enabled: (ctx) => {
      const t = firstTarget(ctx);
      if (!t || t.parentId !== null || hasChildren(t.id)) return false;
      return previousTopSibling(t.id) !== null;
    },
    run: async (ctx) => {
      const t = firstTarget(ctx);
      if (!t || t.parentId !== null || hasChildren(t.id)) return;
      const parent = previousTopSibling(t.id);
      if (!parent) return;
      await moveWithUndo(t, { parentId: parent.id, previousId: PREVIOUS_END }, 'Indent task', 'Indented');
    },
  },

  'task.outdent': {
    enabled: (ctx) => firstTarget(ctx)?.parentId != null,
    run: async (ctx) => {
      const t = firstTarget(ctx);
      if (!t?.parentId) return;
      await moveWithUndo(t, { parentId: null, previousId: t.parentId }, 'Outdent task', 'Outdented');
    },
  },

  'task.moveUp': {
    enabled: (ctx) => moveTarget(ctx, -1) !== null,
    run: async (ctx) => {
      const m = moveTarget(ctx, -1);
      if (m) await moveWithUndo(m.task, { parentId: m.task.parentId, previousId: m.previousId }, 'Move task up', 'Moved up');
    },
  },
  'task.moveDown': {
    enabled: (ctx) => moveTarget(ctx, 1) !== null,
    run: async (ctx) => {
      const m = moveTarget(ctx, 1);
      if (m) await moveWithUndo(m.task, { parentId: m.task.parentId, previousId: m.previousId }, 'Move task down', 'Moved down');
    },
  },

  'task.duplicate': {
    enabled: hasTarget,
    run: async (ctx) => {
      const tasks = targetTasks(ctx);
      if (tasks.length === 0) return;
      const created: string[] = [];
      for (const t of tasks) {
        const copy = await useStore
          .getState()
          .createTask({
            listId: t.listId,
            title: t.title,
            notes: t.notes,
            due: t.due,
            dueTime: t.dueTime,
            parentId: t.parentId,
            previousId: t.id,
            priority: t.priority,
            flagged: t.flagged,
          })
          .catch(() => null);
        if (copy) created.push(copy.id);
      }
      if (created.length === 0) return;
      recordUndoable({
        label: `Duplicate ${plural(created.length, 'task')}`,
        revert: async () => {
          await useStore.getState().deleteTasks(created).catch(() => null);
        },
        apply: async () => {
          await useStore.getState().restoreTasks(created).catch(() => null);
        },
      });
      announce(`Duplicated ${plural(created.length, 'task')}`);
    },
  },

  'task.copyLink': {
    enabled: (ctx) => !!firstTarget(ctx)?.webViewLink,
    run: async (ctx) => {
      const link = firstTarget(ctx)?.webViewLink;
      if (!link) return;
      const ok = await copyText(link);
      useStore.getState().toast({ level: ok ? 'success' : 'error', message: ok ? 'Link copied' : 'Could not copy the link' });
      announce(ok ? 'Link copied' : 'Could not copy the link');
    },
  },

  'task.openInGoogle': {
    enabled: (ctx) => !!firstTarget(ctx)?.webViewLink,
    run: async (ctx) => {
      const link = firstTarget(ctx)?.webViewLink;
      if (!link) return;
      await call('app:openExternal', { url: link }).catch(() => undefined);
    },
  },
};

function priorityCommand(priority: Priority): CommandImpl {
  return {
    enabled: hasTarget,
    run: async (ctx) => {
      const n = targetTasks(ctx).length;
      const name = priority === 0 ? 'none' : priority === 1 ? 'high' : priority === 2 ? 'medium' : 'low';
      await patchTargets(ctx, { priority }, `Set priority on ${plural(n, 'task')}`, `Priority ${name}`);
    },
  };
}

interface MoveTarget {
  task: Task;
  previousId: string | null;
}

/** Where a task would land when nudged `dir` places among its visual siblings. */
function moveTarget(ctx: CommandContext, dir: -1 | 1): MoveTarget | null {
  const task = firstTarget(ctx);
  if (!task) return null;
  const sibs = siblingsOf(task.id);
  const idx = sibs.findIndex((t) => t.id === task.id);
  if (idx < 0) return null;
  if (dir === -1) {
    if (idx === 0) return null;
    return { task, previousId: idx >= 2 ? sibs[idx - 2]!.id : null };
  }
  if (idx >= sibs.length - 1) return null;
  return { task, previousId: sibs[idx + 1]!.id };
}

async function moveWithUndo(task: Task, to: { parentId: string | null; previousId: string | null }, label: string, message: string): Promise<void> {
  const sibs = siblingsOf(task.id);
  const idx = sibs.findIndex((t) => t.id === task.id);
  const from = { parentId: task.parentId, previousId: idx > 0 ? sibs[idx - 1]!.id : null };
  const apply = async (): Promise<void> => {
    await useStore.getState().moveTask({ id: task.id, parentId: to.parentId, previousId: to.previousId }).catch(() => null);
  };
  const revert = async (): Promise<void> => {
    await useStore.getState().moveTask({ id: task.id, parentId: from.parentId, previousId: from.previousId }).catch(() => null);
  };
  await runUndoable({ label, apply, revert });
  announce(message);
}
