import { useState, type ReactElement } from 'react';
import { useStore } from '../../store/store';
import { announce } from '../../lib/announce';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { IconCalendar, IconCheck, IconList, IconTrash, IconX } from '../../components/icons';
import { Dialog } from '../../components/Dialog';
import s from './TaskList.module.css';

export function BulkBar(): ReactElement | null {
  const selection = useStore((st) => st.selection);
  const tasks = useStore((st) => st.tasks);
  const select = useStore((st) => st.select);
  const setStatus = useStore((st) => st.setStatus);
  const deleteTasks = useStore((st) => st.deleteTasks);
  const openOverlay = useStore((st) => st.openOverlay);
  const toast = useStore((st) => st.toast);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const n = selection.length;
  if (n < 2) return null;

  const allDone = selection.every((id) => tasks[id]?.status === 'completed');

  return (
    <>
      <div className={s.bulkBar} role="toolbar" aria-label={`${n} tasks selected`}>
        <span className={s.bulkCount}>{n} selected</span>
        <span className={s.bulkSep} aria-hidden="true" />
        <Button
          size="sm"
          icon={<IconCheck size={13} />}
          onClick={() => {
            announce(`${n} tasks marked ${allDone ? 'not completed' : 'completed'}`);
            void setStatus(selection, !allDone).catch(() => toast({ level: 'error', message: "Couldn't update those tasks." }));
          }}
        >
          {allDone ? `Reopen ${n}` : `Complete ${n}`}
        </Button>
        <Button size="sm" icon={<IconCalendar size={13} />} onClick={() => openOverlay('date-picker', { taskIds: selection })}>
          Set date
        </Button>
        <Button size="sm" icon={<IconList size={13} />} onClick={() => openOverlay('list-picker', { taskIds: selection })}>
          Move
        </Button>
        <Button size="sm" variant="ghost" icon={<IconTrash size={13} />} onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
        <span className={s.bulkSep} aria-hidden="true" />
        <IconButton size="sm" label="Clear selection" icon={<IconX size={13} />} onClick={() => select([])} />
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${n} tasks?`}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                const ids = [...selection];
                announce(`${ids.length} tasks deleted`, 'assertive');
                void deleteTasks(ids).catch(() => toast({ level: 'error', message: "Couldn't delete those tasks." }));
              }}
            >
              Delete {n} tasks
            </Button>
          </>
        }
      >
        <p>This deletes them on Google Tasks too. Subtasks go with their parent.</p>
      </Dialog>
    </>
  );
}
