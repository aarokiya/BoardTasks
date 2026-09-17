import { useMemo, useRef, useState, type ReactElement } from 'react';
import type { Priority, Task } from '@shared/models';
import { TIME_RE } from '@shared/date/civil';
import { formatAgo, formatDueWithTime } from '@shared/date/format';
import { call } from '../../lib/ipc';
import { announce } from '../../lib/announce';
import { useStore } from '../../store/store';
import { selectFocusedTask } from '../../store/selectors/views';
import { runCommand } from '../../commands/registry';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Segmented } from '../../components/Segmented';
import { Textarea, useAutoGrow } from '../../components/Textarea';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Dialog';
import { cx } from '../../components/cx';
import {
  IconAlert,
  IconCalendar,
  IconCheckCircle,
  IconExternal,
  IconFlag,
  IconGithub,
  IconInbox,
  IconList,
  IconTrash,
} from '../../components/icons';
import { GithubCard, useGithubPaste } from '../github';
import { ConflictBanner } from '../conflicts/ConflictBanner';
import { SubtaskList } from './SubtaskList';
import { DatePickerPopover } from './DatePickerPopover';
import { ListPickerPopover } from './ListPickerPopover';
import s from './DetailPane.module.css';

type PriorityKey = '0' | '1' | '2' | '3';

const PRIORITY_OPTIONS: ReadonlyArray<{ value: PriorityKey; label: string; title: string }> = [
  { value: '0', label: 'None', title: 'No priority' },
  { value: '1', label: '!!!', title: 'High priority' },
  { value: '2', label: '!!', title: 'Medium priority' },
  { value: '3', label: '!', title: 'Low priority' },
];

const PRIORITY_NAME: Record<Priority, string> = { 0: 'no priority', 1: 'high priority', 2: 'medium priority', 3: 'low priority' };

function useFailureReporter(): (e: unknown, fallback: string) => void {
  const toast = useStore((st) => st.toast);
  return (e: unknown, fallback: string): void => {
    const message = e instanceof Error ? e.message : fallback;
    announce(message, 'assertive');
    toast({ level: 'error', message });
  };
}

/** The right-hand inspector. Routes between empty, multi-select and single-task. */
export function DetailPane(): ReactElement {
  const selection = useStore((st) => st.selection);
  const focused = useStore(selectFocusedTask);

  if (selection.length > 1) return <BulkPanel ids={selection} />;
  if (!focused) {
    return (
      <div className={s.placeholder}>
        <EmptyState icon={<IconInbox size={20} />} title="No task selected" body="Select a task to see its details." />
      </div>
    );
  }
  return <TaskInspector key={focused.id} task={focused} />;
}

/* ─────────────────────────── single task ─────────────────────────────── */

function TaskInspector({ task }: { task: Task }): ReactElement {
  const today = useStore((st) => st.today);
  const lists = useStore((st) => st.lists);
  const updateTask = useStore((st) => st.updateTask);
  const setStatus = useStore((st) => st.setStatus);
  const openOverlay = useStore((st) => st.openOverlay);
  const fail = useFailureReporter();

  // Drafts are null while not being edited, so a sync push flows straight
  // through to the field instead of being pinned by stale local state.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [timeDraft, setTimeDraft] = useState<string | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [dateBtn, setDateBtn] = useState<HTMLButtonElement | null>(null);
  const [listBtn, setListBtn] = useState<HTMLButtonElement | null>(null);

  const titleValue = titleDraft ?? task.title;
  const notesValue = notesDraft ?? task.notes;
  const onTitlePaste = useGithubPaste({ taskId: task.id, field: 'title', value: titleValue, onChange: setTitleDraft });
  const onNotesPaste = useGithubPaste({ taskId: task.id, field: 'notes', value: notesValue, onChange: setNotesDraft });
  const timeText = timeDraft ?? task.dueTime ?? '';

  // Grows with the text and re-measures when the pane is resized, so a long
  // title wraps instead of being silently cut off at 300px.
  useAutoGrow(titleRef, titleValue);

  const list = lists[task.listId] ?? null;
  const completed = task.status === 'completed';
  const overdue = !completed && task.due !== null && task.due < today;

  const patch = (p: Parameters<typeof updateTask>[1], message: string): void => {
    announce(message);
    void updateTask(task.id, p).catch((e: unknown) => fail(e, 'Could not save that change.'));
  };

  const commitTitle = (): void => {
    if (titleDraft === null) return;
    const value = titleDraft.trim();
    setTitleDraft(null);
    // An emptied title on an existing task is a slip, not an instruction.
    if (value === '' || value === task.title) return;
    patch({ title: value }, `Renamed to ${value}`);
  };

  const commitNotes = (): void => {
    if (notesDraft === null) return;
    const value = notesDraft;
    setNotesDraft(null);
    if (value === task.notes) return;
    patch({ notes: value }, value.trim() === '' ? 'Notes cleared' : 'Notes saved');
  };

  const commitTime = (raw: string): void => {
    const trimmed = raw.trim();
    setTimeDraft(null);
    if (trimmed === '') {
      if (task.dueTime !== null) patch({ dueTime: null }, 'Reminder time cleared');
      return;
    }
    if (!TIME_RE.test(trimmed) || trimmed === task.dueTime) return;
    patch({ dueTime: trimmed }, `Reminder time set to ${trimmed}`);
  };

  const timeTrimmed = timeText.trim();
  const timeInvalid = timeTrimmed !== '' && !TIME_RE.test(timeTrimmed);
  const dueLabel = task.due ? formatDueWithTime(task.due, task.dueTime, today) : 'No due date';

  return (
    <div className={s.pane}>
      <div className={s.scroll}>
        <ConflictBanner task={task} />

        {task.sync === 'failed' ? (
          <div className={s.failedBanner} role="status">
            <span className={s.failedIcon} aria-hidden="true">
              <IconAlert size={16} />
            </span>
            <div className={s.failedText}>
              <div className={s.failedTitle}>This task didn’t reach Google</div>
              <p className={s.failedBody}>
                Your change is safe on this Mac and still shown here. Review it to retry or discard the failed request.
              </p>
              <Button size="sm" variant="secondary" onClick={() => openOverlay('outbox')}>
                Review unsynced changes
              </Button>
            </div>
          </div>
        ) : null}

        <div className={s.titleRow}>
          <textarea
            ref={titleRef}
            rows={1}
            className={cx(s.titleInput, completed && s.titleDone)}
            aria-label="Task title"
            value={titleValue}
            onPaste={onTitlePaste}
            onChange={(e) => setTitleDraft(e.currentTarget.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTitle();
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setTitleDraft(null);
                e.currentTarget.blur();
              }
            }}
          />
          <div className={s.titleActions}>
            <IconButton
              label={completed ? 'Mark as not completed' : 'Mark as completed'}
              icon={<IconCheckCircle />}
              active={completed}
              onClick={() => {
                const next = !completed;
                announce(`${task.title}, ${next ? 'completed' : 'not completed'}`);
                void setStatus([task.id], next).catch((e: unknown) => fail(e, 'Could not update that task.'));
              }}
            />
            <IconButton
              label={task.flagged ? 'Remove flag' : 'Flag task'}
              icon={<IconFlag />}
              active={task.flagged}
              className={task.flagged ? s.flagOn : undefined}
              onClick={() => patch({ flagged: !task.flagged }, task.flagged ? 'Flag removed' : 'Task flagged')}
            />
          </div>
        </div>

        <div className={s.fields}>
          <div className={s.row}>
            <span className={s.rowLabel} id={`bt-f-list-${task.id}`}>
              List
            </span>
            <div className={s.rowValue}>
              <button
                ref={setListBtn}
                type="button"
                className={s.valueButton}
                aria-haspopup="dialog"
                aria-expanded={listOpen}
                aria-labelledby={`bt-f-list-${task.id}`}
                onClick={() => setListOpen((o) => !o)}
              >
                {list ? (
                  <>
                    <span className={s.listDot} style={{ background: `var(--bt-list-${list.color})` }} aria-hidden="true" />
                    <span>{list.title}</span>
                  </>
                ) : (
                  <>
                    <IconList size={13} />
                    <span className={s.valueEmpty}>Unknown list</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className={s.row}>
            <span className={s.rowLabel} id={`bt-f-due-${task.id}`}>
              Due
            </span>
            <div className={s.rowValue}>
              <button
                ref={setDateBtn}
                type="button"
                className={cx(s.valueButton, !task.due && s.valueEmpty, overdue && s.valueOverdue)}
                aria-haspopup="dialog"
                aria-expanded={dateOpen}
                aria-labelledby={`bt-f-due-${task.id}`}
                onClick={() => setDateOpen((o) => !o)}
              >
                <IconCalendar size={13} />
                <span>{overdue ? `${dueLabel} · Overdue` : dueLabel}</span>
              </button>
            </div>
          </div>

          <div className={s.row}>
            <span className={s.rowLabel}>Time</span>
            <div className={s.rowValue}>
              <input
                type="text"
                inputMode="numeric"
                maxLength={5}
                placeholder="HH:mm"
                aria-label="Reminder time"
                aria-invalid={timeInvalid || undefined}
                disabled={task.due === null}
                className={cx(s.timeInput, timeInvalid && s.timeInvalid)}
                value={timeText}
                onChange={(e) => setTimeDraft(e.currentTarget.value)}
                onBlur={(e) => commitTime(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTime(e.currentTarget.value);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setTimeDraft(null);
                  }
                }}
              />
            </div>
          </div>
          {timeInvalid ? (
            <div className={s.error}>Use 24-hour HH:mm, for example 09:30.</div>
          ) : (
            <div className={s.hint}>
              {task.due === null
                ? 'Add a due date to set a reminder time.'
                : 'Reminder time is stored on this Mac only — Google Tasks has no time-of-day.'}
            </div>
          )}

          <div className={s.row}>
            <span className={s.rowLabel}>Priority</span>
            <div className={s.rowValue}>
              <Segmented
                label="Priority"
                value={String(task.priority) as PriorityKey}
                options={PRIORITY_OPTIONS}
                onChange={(v) => {
                  const p = Number(v) as Priority;
                  patch({ priority: p }, `Set ${PRIORITY_NAME[p]}`);
                }}
              />
            </div>
          </div>
        </div>

        <div className={s.separator} />

        <section className={s.section} aria-label="Notes">
          <h3 className={s.sectionTitle}>Notes</h3>
          <Textarea
            aria-label="Notes"
            placeholder="Add notes…"
            minRows={3}
            value={notesValue}
            onPaste={onNotesPaste}
            onChange={(e) => setNotesDraft(e.currentTarget.value)}
            onBlur={commitNotes}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setNotesDraft(null);
                e.currentTarget.blur();
              }
            }}
          />
        </section>

        <div className={s.separator} />

        {task.parentId === null ? (
          <SubtaskList parent={task} />
        ) : (
          <section className={s.section} aria-label="Parent task">
            <h3 className={s.sectionTitle}>Subtask of</h3>
            <div className={s.bulkPreviewItem}>{useStore.getState().tasks[task.parentId]?.title ?? 'A task in another view'}</div>
          </section>
        )}

        <div className={s.separator} />

        <section className={s.section} aria-label="GitHub">
          <h3 className={s.sectionTitle}>GitHub</h3>
          {task.github ? (
            <GithubCard task={task} />
          ) : (
            <div className={s.githubEmpty}>
              <IconGithub size={15} />
              <span className={s.githubEmptyText}>No issue or pull request linked.</span>
              <Button size="sm" variant="secondary" onClick={() => void runCommand('github.link')}>
                Link GitHub issue…
              </Button>
            </div>
          )}
        </section>

        <div className={s.separator} />

        <footer className={s.meta}>
          <div className={s.metaRow}>Created {formatAgo(task.createdAt)}</div>
          <div className={s.metaRow}>Updated {formatAgo(task.updatedAt ?? task.localUpdatedAt)}</div>
          {task.webViewLink ? (
            <div className={s.metaActions}>
              <Button
                size="sm"
                variant="ghost"
                icon={<IconExternal size={13} />}
                onClick={() => {
                  const url = task.webViewLink;
                  if (url) void call('app:openExternal', { url }).catch((e: unknown) => fail(e, 'Could not open that link.'));
                }}
              >
                Open in Google Tasks
              </Button>
            </div>
          ) : null}
        </footer>
      </div>

      <DatePickerPopover
        open={dateOpen}
        onClose={() => setDateOpen(false)}
        anchor={dateBtn}
        due={task.due}
        dueTime={task.dueTime}
        today={today}
        onChange={(due, dueTime) => {
          patch({ due, dueTime }, due ? `Due ${formatDueWithTime(due, dueTime, today)}` : 'Due date cleared');
        }}
      />

      <ListPickerPopover
        open={listOpen}
        onClose={() => setListOpen(false)}
        anchor={listBtn}
        value={task.listId}
        onChange={(listId) => {
          const target = useStore.getState().lists[listId];
          announce(`Moved to ${target?.title ?? 'list'}`);
          void useStore
            .getState()
            .moveTask({ id: task.id, listId, parentId: null, previousId: 'end' })
            .catch((e: unknown) => fail(e, 'Could not move that task.'));
        }}
      />
    </div>
  );
}

/* ───────────────────────────── multi-select ──────────────────────────── */

function BulkPanel({ ids }: { ids: string[] }): ReactElement {
  const version = useStore((st) => st.version);
  const openOverlay = useStore((st) => st.openOverlay);
  const setStatus = useStore((st) => st.setStatus);
  const deleteTasks = useStore((st) => st.deleteTasks);
  const fail = useFailureReporter();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tasks = useMemo(() => {
    void version;
    const all = useStore.getState().tasks;
    return ids.map((id) => all[id]).filter((t): t is Task => t !== undefined);
  }, [ids, version]);

  const openCount = tasks.filter((t) => t.status !== 'completed').length;
  const preview = tasks.slice(0, 5);

  return (
    <div className={s.pane}>
      <div className={s.scroll}>
        <div className={s.bulkHead}>
          <h2 className={s.bulkTitle}>{tasks.length} tasks selected</h2>
          <p className={s.bulkBody}>Actions apply to every selected task.</p>
        </div>

        <div className={s.bulkPreview}>
          {preview.map((t) => (
            <span key={t.id} className={s.bulkPreviewItem}>
              {t.title}
            </span>
          ))}
          {tasks.length > preview.length ? (
            <span className={s.bulkPreviewItem}>and {tasks.length - preview.length} more…</span>
          ) : null}
        </div>

        <div className={s.separator} />

        <div className={s.bulkActions}>
          <Button
            variant="primary"
            fullWidth
            icon={<IconCheckCircle size={14} />}
            disabled={openCount === 0}
            onClick={() => {
              announce(`Completed ${openCount} tasks`);
              void setStatus(
                tasks.filter((t) => t.status !== 'completed').map((t) => t.id),
                true,
              ).catch((e: unknown) => fail(e, 'Could not complete those tasks.'));
            }}
          >
            Complete {openCount === 0 ? 'all' : openCount}
          </Button>
          <Button variant="secondary" fullWidth icon={<IconCalendar size={14} />} onClick={() => openOverlay('date-picker', { taskIds: ids })}>
            Set date…
          </Button>
          <Button variant="secondary" fullWidth icon={<IconList size={14} />} onClick={() => openOverlay('list-picker', { taskIds: ids })}>
            Move to list…
          </Button>
          <Button variant="danger" fullWidth icon={<IconTrash size={14} />} onClick={() => setConfirmDelete(true)}>
            Delete {tasks.length}
          </Button>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${tasks.length} tasks?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                announce(`Deleted ${tasks.length} tasks`);
                void deleteTasks(ids).catch((e: unknown) => fail(e, 'Could not delete those tasks.'));
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        Their subtasks are deleted too. This also deletes them from Google Tasks the next time BoardTasks syncs.
      </Dialog>
    </div>
  );
}
