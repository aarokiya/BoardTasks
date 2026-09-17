import { useMemo, useRef, useState, type ReactElement } from 'react';
import type { Task } from '@shared/models';
import { announce } from '../../lib/announce';
import { useStore } from '../../store/store';
import { IconCheck, IconPlus } from '../../components/icons';
import { cx } from '../../components/cx';
import s from './DetailPane.module.css';

export interface SubtaskListProps {
  parent: Task;
}

/** The one level of nesting Google Tasks supports, edited inline. */
export function SubtaskList({ parent }: SubtaskListProps): ReactElement {
  const version = useStore((st) => st.version);
  const createTask = useStore((st) => st.createTask);
  const setStatus = useStore((st) => st.setStatus);
  const updateTask = useStore((st) => st.updateTask);
  const toast = useStore((st) => st.toast);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const addRef = useRef<HTMLInputElement>(null);

  const parentId = parent.id;
  const children = useMemo(() => {
    void version;
    return Object.values(useStore.getState().tasks)
      .filter((t) => t.parentId === parentId && !t.deleted)
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  }, [version, parentId]);

  const done = children.filter((t) => t.status === 'completed').length;

  const fail = (e: unknown, fallback: string): void => {
    const message = e instanceof Error ? e.message : fallback;
    announce(message, 'assertive');
    toast({ level: 'error', message });
  };

  const toggle = (t: Task): void => {
    const next = t.status !== 'completed';
    announce(`${t.title}, ${next ? 'completed' : 'not completed'}`);
    void setStatus([t.id], next).catch((e: unknown) => fail(e, 'Could not update that subtask.'));
  };

  const commitTitle = (t: Task): void => {
    const value = draft.trim();
    setEditingId(null);
    if (value === '' || value === t.title) return;
    announce(`Renamed to ${value}`);
    void updateTask(t.id, { title: value }).catch((e: unknown) => fail(e, 'Could not rename that subtask.'));
  };

  const addSubtask = (): void => {
    const title = newTitle.trim();
    if (title === '') return;
    setNewTitle('');
    announce(`Added subtask ${title}`);
    void createTask({ listId: parent.listId, title, parentId: parent.id, previousId: 'end' })
      .catch((e: unknown) => fail(e, 'Could not add that subtask.'))
      .finally(() => addRef.current?.focus());
  };

  return (
    <section className={s.section} aria-label="Subtasks">
      <div className={s.sectionHead}>
        <h3 className={s.sectionTitle}>Subtasks</h3>
        {children.length > 0 ? (
          <span className={s.sectionCount}>
            {done}/{children.length}
          </span>
        ) : null}
      </div>

      <ul className={s.subtasks}>
        {children.map((t) => {
          const completed = t.status === 'completed';
          return (
            <li key={t.id} className={s.subtask}>
              <button
                type="button"
                role="checkbox"
                aria-checked={completed}
                aria-label={`${t.title}, ${completed ? 'completed' : 'not completed'}`}
                className={cx(s.check, completed && s.checkOn)}
                onClick={() => toggle(t)}
              >
                {completed ? <IconCheck size={11} strokeWidth={2.4} /> : null}
              </button>

              {editingId === t.id ? (
                <input
                  className={s.subtaskTitle}
                  aria-label={`Subtask title, ${t.title}`}
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.currentTarget.value)}
                  onBlur={() => commitTitle(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitTitle(t);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditingId(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={cx(s.subtaskTitle, completed && s.subtaskDone)}
                  title={t.title}
                  onClick={() => {
                    setDraft(t.title);
                    setEditingId(t.id);
                  }}
                >
                  {t.title}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className={s.subtaskAdd}>
        <span className={s.subtaskAddIcon} aria-hidden="true">
          <IconPlus size={13} />
        </span>
        <input
          ref={addRef}
          className={s.subtaskAddInput}
          placeholder="Add subtask"
          aria-label="Add subtask"
          value={newTitle}
          onChange={(e) => setNewTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addSubtask();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setNewTitle('');
            }
          }}
        />
      </div>
    </section>
  );
}
