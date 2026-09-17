import { useCallback, useRef, useState, type ReactElement } from 'react';
import { PREVIOUS_END, type TaskCreateInput } from '@shared/models';
import { announce } from '../../lib/announce';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { selectDefaultListId, selectLists } from '../../store/selectors/views';
import { QuickAddField } from './QuickAddField';
import { useQuickAddParse } from './useQuickAddParse';
import s from './InlineQuickAdd.module.css';

export interface InlineQuickAddProps {
  listId: string | null;
  parentId?: string | null;
  onDone: () => void;
  autoFocus?: boolean;
}

/**
 * The ⌘N row the task list renders at the top of a list (or under a parent for
 * subtasks). Enter creates and stays open for rapid entry; ⇧Enter creates and
 * closes; Esc clears, then closes.
 */
export function InlineQuickAdd({ listId, parentId = null, onDone, autoFocus = true }: InlineQuickAddProps): ReactElement {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const lists = useStore(selectLists);
  const today = useStore((st) => st.today);
  const dateOrder = useStore((st) => st.settings?.dateOrder ?? 'MDY');
  const fallbackList = useStore(selectDefaultListId);
  const defaultListId = listId ?? fallbackList;

  const parsed = useQuickAddParse(value, { lists, defaultListId, today, dateOrder });

  const submit = useCallback(
    async (keepOpen: boolean): Promise<void> => {
      if (busy) return;
      if (value.trim() === '') {
        onDone();
        return;
      }
      if (parsed.title.trim() === '') return;
      setBusy(true);
      try {
        let targetList = parsed.listId;
        if (parsed.listQuery) {
          const created = await call('lists:create', { title: parsed.listQuery }).catch(() => null);
          if (created) {
            useStore.setState((st) => ({ lists: { ...st.lists, [created.id]: created }, version: st.version + 1 }));
            targetList = created.id;
          }
        }
        const input: TaskCreateInput = {
          title: parsed.title,
          notes: parsed.notes,
          due: parsed.due,
          dueTime: parsed.dueTime,
          priority: parsed.priority,
          flagged: parsed.flagged,
          parentId,
          previousId: parentId ? PREVIOUS_END : null,
        };
        if (targetList) input.listId = targetList;
        await useStore.getState().createTask(input);
        announce('Task created');
        setValue('');
        if (!keepOpen) onDone();
        else inputRef.current?.focus();
      } catch {
        useStore.getState().toast({ level: 'error', message: 'Could not create the task' });
      } finally {
        setBusy(false);
      }
    },
    [busy, onDone, parentId, parsed, value],
  );

  return (
    <div className={s.row} data-testid="inline-quick-add">
      <span className={s.bullet} aria-hidden="true" />
      <QuickAddField
        value={value}
        onChange={setValue}
        parsed={parsed}
        lists={lists}
        today={today}
        variant="inline"
        placeholder={parentId ? 'New subtask…' : 'New task — try “review specs tomorrow 4pm #work !1”'}
        autoFocus={autoFocus}
        inputRef={inputRef}
        onSubmit={(shiftKey) => void submit(!shiftKey)}
        onCancel={onDone}
      />
    </div>
  );
}
