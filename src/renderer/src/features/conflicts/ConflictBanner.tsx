import { useState, type ReactElement } from 'react';
import type { Task } from '@shared/models';
import type { CivilDate } from '@shared/date/civil';
import { formatAgo, formatRelative } from '@shared/date/format';
import { call } from '../../lib/ipc';
import { announce } from '../../lib/announce';
import { useStore } from '../../store/store';
import { Button } from '../../components/Button';
import { IconAlert } from '../../components/icons';
import { cx } from '../../components/cx';
import s from './ConflictBanner.module.css';

type Resolution = 'keepLocal' | 'useServer' | 'restore' | 'discard';
type ConflictField = 'title' | 'notes' | 'status' | 'due';

const FIELD_LABEL: Record<ConflictField, string> = {
  title: 'Title',
  notes: 'Notes',
  status: 'Status',
  due: 'Due date',
};

const isConflictField = (f: string): f is ConflictField => f === 'title' || f === 'notes' || f === 'status' || f === 'due';

function describe(field: ConflictField, value: string | null | undefined, today: CivilDate): { text: string; empty: boolean } {
  if (field === 'status') return { text: value === 'completed' ? 'Completed' : 'Not completed', empty: false };
  if (value === null || value === undefined || value === '') {
    return { text: field === 'due' ? 'No due date' : 'Empty', empty: true };
  }
  if (field === 'due') return { text: formatRelative(value as CivilDate, today), empty: false };
  return { text: value, empty: false };
}

/**
 * Shown at the top of the inspector when the sync engine found a genuine
 * both-sides-changed conflict. Never resolves silently — the user picks.
 */
export function ConflictBanner({ task }: { task: Task }): ReactElement | null {
  const today = useStore((st) => st.today);
  const toast = useStore((st) => st.toast);
  const [busy, setBusy] = useState<Resolution | null>(null);
  const conflict = task.conflict;

  if (!conflict) return null;

  const resolve = async (resolution: Resolution, successMessage: string): Promise<void> => {
    setBusy(resolution);
    try {
      const resolved = await call('tasks:resolveConflict', { id: task.id, resolution });
      const store = useStore.getState();
      if (resolved) {
        store.applyEvent({ type: 'data:changed', reason: 'conflict', tasks: [resolved], lists: [], deletedTaskIds: [], deletedListIds: [] });
      } else {
        store.applyEvent({ type: 'data:changed', reason: 'conflict', tasks: [], lists: [], deletedTaskIds: [task.id], deletedListIds: [] });
      }
      announce(successMessage);
      toast({ level: 'success', message: successMessage });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not resolve this conflict.';
      announce(message, 'assertive');
      toast({ level: 'error', message });
    } finally {
      setBusy(null);
    }
  };

  if (conflict.remoteDeleted) {
    return (
      <section className={cx(s.banner, s.bannerDeleted)} aria-label="Sync conflict">
        <div className={s.head}>
          <span className={s.headIcon} aria-hidden="true">
            <IconAlert size={16} />
          </span>
          <div className={s.headText}>
            <div className={s.title}>This task was deleted on another device</div>
            <p className={s.body}>
              You edited it here after it was deleted, so your version is still on this Mac. Restore it to create it again in Google Tasks,
              or discard it to accept the deletion.
            </p>
          </div>
        </div>
        <div className={s.actions}>
          <Button variant="primary" disabled={busy !== null} onClick={() => void resolve('restore', `Restored “${task.title}”`)}>
            Restore
          </Button>
          <Button variant="danger" disabled={busy !== null} onClick={() => void resolve('discard', `Discarded “${task.title}”`)}>
            Discard
          </Button>
        </div>
        <div className={s.detectedAt}>Detected {formatAgo(conflict.detectedAt)}</div>
      </section>
    );
  }

  const fields = conflict.fields.filter(isConflictField);

  return (
    <section className={s.banner} aria-label="Sync conflict">
      <div className={s.head}>
        <span className={s.headIcon} aria-hidden="true">
          <IconAlert size={16} />
        </span>
        <div className={s.headText}>
          <div className={s.title}>This task changed in two places</div>
          <p className={s.body}>
            Someone changed {fields.length === 1 ? 'the same field' : 'the same fields'} on another device while you were editing here.
            Nothing was overwritten — pick which version to keep.
          </p>
        </div>
      </div>

      <div className={s.fields}>
        {fields.map((field) => {
          const theirs = describe(field, conflict.server[field] ?? null, today);
          const mine = describe(field, task[field], today);
          return (
            <div key={field} className={s.field}>
              <div className={s.fieldName}>{FIELD_LABEL[field]}</div>
              <div className={s.side}>
                <span className={s.sideLabel}>Theirs</span>
                <span className={cx(s.sideValue, theirs.empty && s.sideEmpty)}>{theirs.text}</span>
              </div>
              <div className={s.side}>
                <span className={s.sideLabel}>Yours</span>
                <span className={cx(s.sideValue, mine.empty && s.sideEmpty)}>{mine.text}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className={s.actions}>
        <Button variant="primary" disabled={busy !== null} onClick={() => void resolve('keepLocal', 'Kept your version')}>
          Keep mine
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => void resolve('useServer', 'Used the version from the server')}>
          Use theirs
        </Button>
      </div>
      <div className={s.detectedAt}>Detected {formatAgo(conflict.detectedAt)}</div>
    </section>
  );
}
