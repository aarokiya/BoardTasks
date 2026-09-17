import { announce } from '../../lib/announce';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { selectCurrentListId, selectDefaultListId } from '../../store/selectors/views';
import type { CommandId } from '../ids';
import type { CommandContext, CommandImpl } from '../registry';

/** The list a new task should land in: the open list, else the default list. */
export function addTargetListId(): string | null {
  const s = useStore.getState();
  return selectCurrentListId(s) ?? selectDefaultListId(s);
}

/** The top-level task a new subtask should hang off, or null. */
export function subtaskParentId(ctx: CommandContext): string | null {
  const s = useStore.getState();
  const id = ctx.focusId ?? ctx.selection[0] ?? null;
  const t = id ? s.tasks[id] : undefined;
  if (!t) return null;
  return t.parentId ?? t.id;
}

const openInlineAdd: CommandImpl = {
  enabled: () => addTargetListId() !== null,
  run: () => {
    const listId = addTargetListId();
    if (!listId) return;
    const s = useStore.getState();
    s.setInlineAddFor({ listId, parentId: null });
    s.setEditing(null);
    announce('New task');
  },
};

export const createCommands: Partial<Record<CommandId, CommandImpl>> = {
  'create.task': openInlineAdd,
  'create.quickadd': openInlineAdd,

  'create.subtask': {
    enabled: (ctx) => subtaskParentId(ctx) !== null,
    run: (ctx) => {
      const parentId = subtaskParentId(ctx);
      if (!parentId) return;
      const s = useStore.getState();
      const parent = s.tasks[parentId];
      if (!parent) return;
      s.setInlineAddFor({ listId: parent.listId, parentId });
      announce('New subtask');
    },
  },

  'create.list': {
    run: async () => {
      const list = await call('lists:create', { title: 'New List' }).catch(() => null);
      if (!list) {
        useStore.getState().toast({ level: 'error', message: 'Could not create the list' });
        return;
      }
      useStore.setState((s) => ({ lists: { ...s.lists, [list.id]: list }, version: s.version + 1 }));
      const s = useStore.getState();
      s.setView(`list:${list.id}`);
      s.setRenamingListId(list.id);
      announce('New list — type a name');
    },
  },
};
