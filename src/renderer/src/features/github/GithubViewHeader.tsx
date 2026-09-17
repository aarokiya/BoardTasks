import { useMemo, type ReactElement } from 'react';
import type { Task } from '@shared/models';
import { Button } from '../../components/Button';
import { useStore, type GithubFilter } from '../../store/store';
import { isOpen, matchesGithubFilter } from '../../store/selectors/views';
import s from './github.module.css';

const PILLS: Array<{ id: GithubFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'issues', label: 'Issues' },
  { id: 'prs', label: 'PRs' },
  { id: 'failing', label: 'Failing checks' },
];

/** Rendered by the shell above the list when the GitHub smart view is active. */
export function GithubViewHeader(): ReactElement | null {
  const view = useStore((st) => st.view);
  const tasksById = useStore((st) => st.tasks);
  const filter = useStore((st) => st.githubFilter);
  const setGithubFilter = useStore((st) => st.setGithubFilter);
  const setStatus = useStore((st) => st.setStatus);
  const pushUndo = useStore((st) => st.pushUndo);
  const toast = useStore((st) => st.toast);

  const { counts, done } = useMemo(() => {
    const tasks = Object.values(tasksById).filter((t) => isOpen(t) && t.github !== null);
    const c: Record<GithubFilter, number> = { all: 0, issues: 0, prs: 0, failing: 0 };
    for (const t of tasks) for (const p of PILLS) if (matchesGithubFilter(t, p.id)) c[p.id] += 1;
    const closedOut = tasks.filter((t) => t.github?.state === 'merged' || t.github?.state === 'closed');
    return { counts: c, done: closedOut };
  }, [tasksById]);

  if (view !== 'github') return null;

  const completeAll = async (tasks: Task[]): Promise<void> => {
    const ids = tasks.map((t) => t.id);
    if (ids.length === 0) return;
    await setStatus(ids, true);
    pushUndo({
      label: `Complete ${ids.length} GitHub task${ids.length === 1 ? '' : 's'}`,
      undo: async () => { await setStatus(ids, false); },
      redo: async () => { await setStatus(ids, true); },
    });
    toast({ level: 'success', message: `Completed ${ids.length} task${ids.length === 1 ? '' : 's'}`, actionLabel: 'Undo', onAction: () => void useStore.getState().undo() });
  };

  return (
    <div className={s.viewHeader} data-testid="gh-view-header">
      <div className={s.pills} role="group" aria-label="GitHub filters">
        {PILLS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={s.pill}
            aria-pressed={filter === p.id}
            onClick={() => { setGithubFilter(p.id); }}
          >
            {`${p.label} ${counts[p.id]}`}
          </button>
        ))}
      </div>
      <span className={s.viewSpacer} />
      {done.length > 0 ? (
        <Button size="sm" onClick={() => void completeAll(done)}>
          {`Complete tasks for merged/closed items (${done.length})`}
        </Button>
      ) : null}
    </div>
  );
}
