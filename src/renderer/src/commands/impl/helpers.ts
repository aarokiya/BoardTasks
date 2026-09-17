import type { Task, TaskUpdateInput } from '@shared/models';
import { announce } from '../../lib/announce';
import { runUndoable } from '../../features/undo';
import { useStore } from '../../store/store';
import { selectTaskRows } from '../../store/selectors/views';
import type { CommandContext } from '../registry';

/** Commands act on the selection, falling back to the focused row. */
export function targetIds(ctx: CommandContext): string[] {
  if (ctx.selection.length > 0) return ctx.selection;
  return ctx.focusId ? [ctx.focusId] : [];
}

export function targetTasks(ctx: CommandContext): Task[] {
  const { tasks } = useStore.getState();
  return targetIds(ctx)
    .map((id) => tasks[id])
    .filter((t): t is Task => !!t);
}

export const hasTarget = (ctx: CommandContext): boolean => targetTasks(ctx).length > 0;

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

type Patch = TaskUpdateInput['patch'];

/**
 * Optimistically patch every target task, push one undo entry that restores the
 * previous per-task values, and announce the result.
 */
export async function patchTargets(ctx: CommandContext, patch: Patch, label: string, message: string): Promise<void> {
  const tasks = targetTasks(ctx);
  if (tasks.length === 0) return;
  const keys = Object.keys(patch) as Array<keyof Patch>;
  const before: Array<{ id: string; prev: Patch }> = tasks.map((t) => ({ id: t.id, prev: Object.fromEntries(keys.map((k) => [k, t[k]])) }));

  const apply = async (): Promise<void> => {
    const { updateTask } = useStore.getState();
    await Promise.all(tasks.map((t) => updateTask(t.id, patch).catch(() => null)));
  };
  const revert = async (): Promise<void> => {
    const { updateTask } = useStore.getState();
    await Promise.all(before.map((b) => updateTask(b.id, b.prev).catch(() => null)));
  };

  await runUndoable({ label, apply, revert });
  announce(message);
}

/** Visual siblings of `task` in the current view, in display order. */
export function siblingsOf(taskId: string): Task[] {
  const state = useStore.getState();
  const task = state.tasks[taskId];
  if (!task) return [];
  return selectTaskRows(state)
    .map((r) => r.task!)
    .filter((t) => t.listId === task.listId && t.parentId === task.parentId);
}

/** The visual row immediately above `taskId` at depth 0, or null. */
export function previousTopSibling(taskId: string): Task | null {
  const state = useStore.getState();
  const rows = selectTaskRows(state);
  const idx = rows.findIndex((r) => r.id === taskId);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.depth === 0 && row.task && row.task.listId === state.tasks[taskId]?.listId) return row.task;
  }
  return null;
}

export const hasChildren = (taskId: string): boolean => Object.values(useStore.getState().tasks).some((t) => t.parentId === taskId);

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
