import { useCallback, useEffect, useRef } from 'react';
import type { ClipboardEvent } from 'react';
import { canonicalGithubUrl, findGithubRefIn, shortGithubLabel } from '@shared/github-url';
import { call, onMainEvent } from '../../lib/ipc';
import { useStore } from '../../store/store';

export interface UseGithubPasteOptions {
  /** Null while the task does not exist yet (the paste then behaves normally). */
  taskId: string | null;
  field: 'title' | 'notes';
  /** Current field text and its setter, so the URL can be stripped in place. */
  value: string;
  onChange: (next: string) => void;
  enabled?: boolean;
}

/** Give up waiting for enrichment after this long — the toast would be a lie. */
const ADOPT_TIMEOUT_MS = 20_000;

/**
 * Paste a GitHub issue/PR link into a task title or notes and it becomes a
 * link instead of a wall of URL. If the title was *only* the URL, the fetched
 * issue title takes its place once enrichment lands, with an undo toast.
 *
 * Usage (title input):
 *
 *   const onPaste = useGithubPaste({ taskId: task.id, field: 'title', value: draft, onChange: setDraft });
 *   <input value={draft} onChange={…} onPaste={onPaste} />
 */
export function useGithubPaste({ taskId, field, value, onChange, enabled = true }: UseGithubPasteOptions): (e: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void {
  const awaiting = useRef<{ taskId: string; previous: string; until: number } | null>(null);

  const adopt = useCallback((title: string): void => {
    const pending = awaiting.current;
    if (!pending) return;
    awaiting.current = null;
    const { taskId: id, previous } = pending;
    const store = useStore.getState();
    onChange(title);
    void store.updateTask(id, { title });
    store.toast({
      level: 'info',
      message: 'Title taken from GitHub',
      actionLabel: 'Undo',
      onAction: () => {
        onChange(previous);
        void useStore.getState().updateTask(id, { title: previous });
      },
    });
  }, [onChange]);

  useEffect(() => {
    if (field !== 'title') return;
    return onMainEvent((e) => {
      const pending = awaiting.current;
      if (!pending || e.type !== 'data:changed') return;
      if (Date.now() > pending.until) { awaiting.current = null; return; }
      const task = e.tasks.find((t) => t.id === pending.taskId);
      const title = task?.github?.title ?? null;
      if (title !== null && title !== '') adopt(title);
    });
  }, [field, adopt]);

  return useCallback(
    (e: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      if (!enabled || taskId === null) return;
      const text = e.clipboardData.getData('text/plain');
      if (text === '') return;
      const found = findGithubRefIn(text);
      if (!found) return;

      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? start;
      const remainder = text.split(found.raw).join(' ').replace(/\s+/g, ' ').trim();
      const next = `${value.slice(0, start)}${remainder}${value.slice(end)}`.replace(/\s+/g, ' ').trim();
      onChange(next);

      const url = canonicalGithubUrl(found.ref);
      const label = shortGithubLabel(found.ref);
      const store = useStore.getState();
      if (field === 'title' && next === '') {
        awaiting.current = { taskId, previous: value, until: Date.now() + ADOPT_TIMEOUT_MS };
      }
      void call('github:link', { taskId, url })
        .then((link) => {
          store.toast({ level: 'success', message: `Linked ${label}`, timeoutMs: 3000 });
          if (link.title !== null && link.title !== '') adopt(link.title);
        })
        .catch(() => {
          awaiting.current = null;
          store.toast({ level: 'error', message: `Could not link ${label}` });
        });
    },
    [enabled, taskId, value, onChange, field, adopt],
  );
}
