import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { OutboxEntry } from '@shared/models';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { Button } from '../../components/Button';
import { Chip, type ChipTone } from '../../components/Chip';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { IconAlert, IconCheckCircle, IconCopy, IconRefresh, IconTrash } from '../../components/icons';
import { announce } from '../../lib/announce';
import s from './OutboxSheet.module.css';

const ERROR_COPY: Record<string, string> = {
  RATE_LIMITED: 'Google is limiting how fast this account can change tasks. BoardTasks will try again on its own.',
  AUTH: 'Sign in to Google again to finish this change.',
  UNAUTHENTICATED: 'Sign in to Google again to finish this change.',
  FORBIDDEN: 'Google refused this change for this account. Check the app\u2019s access in your Google account settings.',
  NETWORK: 'No connection to Google. This will send as soon as you are back online.',
  VALIDATION: 'Google would not accept this change.',
  NOT_FOUND: 'This task no longer exists in Google Tasks.',
  CONFLICT: 'This task was changed somewhere else. Resolve the conflict on the task to send your version.',
  DEPENDENCY_FAILED: 'This change depends on another change that has not reached Google yet.',
  INTERNAL: 'Something went wrong on the way to Google. Try again.',
};

/** The sentence a person reads. Never a code, never a raw payload. */
function humanError(entry: OutboxEntry): string | null {
  if (entry.lastErrorCode && ERROR_COPY[entry.lastErrorCode]) return ERROR_COPY[entry.lastErrorCode]!;
  if (entry.lastError) return entry.lastError;
  return null;
}

/** What Google actually said — shown quietly underneath, for a bug report. */
function rawDetail(entry: OutboxEntry): string | null {
  if (!entry.lastError) return null;
  if (!entry.lastErrorCode || !ERROR_COPY[entry.lastErrorCode]) return null;
  return entry.lastError;
}

/** "Tried once" / "Tried 4 times" — never "Attempt 1 · task.create". */
function attemptCopy(attempts: number): string | null {
  if (attempts <= 1) return null;
  if (attempts === 2) return 'Tried twice';
  return `Tried ${attempts} times`;
}

const STATUS_LABEL: Record<OutboxEntry['status'], string> = {
  pending: 'Pending',
  inflight: 'In flight',
  blocked: 'Waiting on another change',
  parked: 'Needs attention',
  done: 'Done',
};

const STATUS_TONE: Record<OutboxEntry['status'], ChipTone> = {
  pending: 'neutral',
  inflight: 'accent',
  blocked: 'neutral',
  parked: 'danger',
  done: 'success',
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: OutboxEntry[] }
  | { kind: 'error'; message: string };

export function OutboxSheet(): ReactElement {
  const closeOverlay = useStore((st) => st.closeOverlay);
  const toast = useStore((st) => st.toast);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Bumping the key re-runs the fetch effect; the fetch itself lives in the
  // effect so no state is written synchronously while it runs.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entries = await call('outbox:list');
        if (!cancelled) setState({ kind: 'ready', entries });
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not read the outbox.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const act = async (fn: () => Promise<unknown>, success: string, failure: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      announce(success);
      reload();
    } catch (e) {
      toast({ level: 'error', message: `${failure}${e instanceof Error ? `: ${e.message}` : ''}` });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const copyDetails = async (entry: OutboxEntry): Promise<void> => {
    const payload = JSON.stringify(entry, null, 2);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(payload);
      toast({ level: 'success', message: 'Details copied to the clipboard' });
    } catch {
      toast({ level: 'error', message: 'Could not copy — the clipboard is unavailable' });
    }
  };

  const entries = state.kind === 'ready' ? state.entries : [];
  const hasEntries = entries.length > 0;

  return (
    <Dialog
      open
      onClose={closeOverlay}
      title="Unsynced changes"
      description="Changes waiting to reach Google, with any errors that stopped them."
      size="wide"
      flushBody
      footer={
        <>
          {hasEntries ? (
            <span className={s.footerNote}>
              {entries.length} {entries.length === 1 ? 'change' : 'changes'} queued
            </span>
          ) : null}
          {hasEntries ? (
            <Button variant="secondary" disabled={busy} icon={<IconRefresh size={14} />} onClick={() => void act(() => call('outbox:retryAll'), 'Retrying all changes', 'Retry all failed')}>
              Retry all
            </Button>
          ) : null}
          <Button variant="primary" onClick={closeOverlay}>
            Close
          </Button>
        </>
      }
    >
      {state.kind === 'loading' ? (
        <div className={s.skeletons}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={s.skeletonRow}>
              <Skeleton width="56%" height={13} />
              <Skeleton width="34%" height={11} />
            </div>
          ))}
        </div>
      ) : state.kind === 'error' ? (
        <div className={s.errorState} role="alert">
          <IconAlert size={22} />
          <span className={s.errorStateTitle}>Could not load unsynced changes</span>
          <span>{state.message}</span>
          <Button
            variant="secondary"
            onClick={() => {
              setState({ kind: 'loading' });
              reload();
            }}
          >
            Try again
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<IconCheckCircle size={22} />}
          title="Everything is synced"
          body="Changes you make offline show up here until they reach Google."
        />
      ) : (
        <div className={s.list}>
          {entries.map((entry) => {
            const message = humanError(entry);
            const detail = rawDetail(entry);
            const tried = attemptCopy(entry.attempts);
            return (
              <div key={entry.id} className={s.row}>
                <div className={s.main}>
                  <span className={s.description}>{entry.description}</span>
                  {message ? <span className={s.error}>{message}</span> : null}
                  {detail ? <span className={s.detail}>Google said: {detail}</span> : null}
                  <div className={s.metaRow}>
                    <Chip tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Chip>
                    {tried ? <span className={s.meta}>{tried}</span> : null}
                  </div>
                </div>
                <div className={s.actions}>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => call('outbox:retry', { id: entry.id }), 'Retrying change', 'Retry failed')}>
                    Retry
                  </Button>
                  <Button size="sm" variant="ghost" icon={<IconCopy size={13} />} onClick={() => void copyDetails(entry)}>
                    Copy details
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconTrash size={13} />}
                    onClick={() => setConfirmId(entry.id)}
                    aria-label={`Discard change: ${entry.description}`}
                  >
                    Discard
                  </Button>
                </div>
                {confirmId === entry.id ? (
                  <div className={s.confirm} role="alertdialog" aria-label="Confirm discard">
                    <span className={s.confirmText}>Discard this change permanently? It will never reach Google.</span>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                      Keep
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setConfirmId(null);
                        void act(() => call('outbox:discard', { id: entry.id }), 'Change discarded', 'Discard failed');
                      }}
                    >
                      Discard
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
