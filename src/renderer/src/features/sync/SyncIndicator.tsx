import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { SyncStatusKind } from '@shared/models';
import { formatAgo } from '@shared/date/format';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';
import { Popover } from '../../components/Popover';
import { Spinner } from '../../components/Spinner';
import { cx } from '../../components/cx';
import {
  IconAlert,
  IconCloudOff,
  IconClock,
  IconPause,
  IconRefresh,
  IconSignOut,
  IconWifi,
  IconList,
} from '../../components/icons';
import s from './SyncIndicator.module.css';

type Tone = 'neutral' | 'danger' | 'warn' | 'accent';

interface Visual {
  /** Stable machine-readable state, exposed as data-state. */
  state: SyncStatusKind | 'connecting';
  word: string;
  icon: ReactNode;
  tone: Tone;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function SyncIndicator(): ReactElement {
  const sync = useStore((st) => st.sync);
  const auth = useStore((st) => st.auth);
  const online = useStore((st) => st.online);
  const openOverlay = useStore((st) => st.openOverlay);
  const toast = useStore((st) => st.toast);

  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const status: SyncStatusKind | null = sync?.status ?? null;
  const reauth = status === 'reauth_required' || auth?.state === 'reauth_required';
  const pendingCount = sync?.pendingCount ?? 0;
  const failedCount = sync?.failedCount ?? 0;
  const unsynced = pendingCount + failedCount;

  // Only show the spinner once syncing has lasted longer than 250ms, so a fast
  // round trip never flashes.
  const showSpinner = useDelayedFlag(status === 'syncing', 250);

  // Live countdown while rate-limited. The deadline is captured inside the
  // effect so render stays pure, and only the interval callback sets state.
  const retryAfterMs = status === 'rate_limited' ? (sync?.retryAfterMs ?? null) : null;
  const [countdown, setCountdown] = useState<{ key: number; ms: number } | null>(null);
  useEffect(() => {
    if (retryAfterMs === null) return;
    const deadline = Date.now() + retryAfterMs;
    const id = setInterval(() => setCountdown({ key: retryAfterMs, ms: Math.max(0, deadline - Date.now()) }), 1000);
    return () => clearInterval(id);
  }, [retryAfterMs]);
  const remainingMs = countdown && countdown.key === retryAfterMs ? countdown.ms : (retryAfterMs ?? 0);

  const visual: Visual = (() => {
    if (reauth) return { state: 'reauth_required', word: 'Sign in', icon: <IconSignOut size={13} />, tone: 'accent' };
    if (status === 'captive_portal') {
      return { state: 'captive_portal', word: 'Sign in to this network', icon: <IconWifi size={13} />, tone: 'warn' };
    }
    if (status === 'offline' || (sync !== null && !online)) {
      return { state: 'offline', word: 'Offline', icon: <IconCloudOff size={13} />, tone: 'neutral' };
    }
    if (status === 'rate_limited') {
      return { state: 'rate_limited', word: `Retrying in ${formatCountdown(remainingMs)}`, icon: <IconClock size={13} />, tone: 'warn' };
    }
    if (status === 'error') return { state: 'error', word: 'Sync error', icon: <IconAlert size={13} />, tone: 'danger' };
    if (status === 'paused') {
      const word = auth?.state === 'signed_in' ? 'Sync paused' : 'Not connected';
      return { state: 'paused', word, icon: <IconPause size={13} />, tone: 'neutral' };
    }
    if (status === 'syncing' && showSpinner) {
      return { state: 'syncing', word: 'Syncing…', icon: <Spinner size={13} />, tone: 'neutral' };
    }
    if (sync === null) {
      return { state: 'connecting', word: 'Connecting…', icon: <span className={s.dot} />, tone: 'neutral' };
    }
    // A parked change is not "synced": say so, in the danger tone, until it is retried or discarded.
    if (failedCount > 0) {
      return { state: 'error', word: `${failedCount} ${failedCount === 1 ? 'change' : 'changes'} didn't sync`, icon: <IconAlert size={13} />, tone: 'danger' };
    }
    return { state: status === 'syncing' ? 'syncing' : 'idle', word: 'Synced', icon: <span className={s.dot} />, tone: 'neutral' };
  })();

  const lastAgo = formatAgo(sync?.lastSyncSucceededAt ?? null);
  const ariaLabel = `Sync status: ${visual.word}${pendingCount > 0 ? `, ${pendingCount} unsynced ${pendingCount === 1 ? 'change' : 'changes'}` : ''}`;

  const run = async (fn: () => Promise<unknown>, failMessage: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast({ level: 'error', message: `${failMessage}${e instanceof Error ? `: ${e.message}` : ''}` });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const toneClass = visual.tone === 'danger' ? s.toneDanger : visual.tone === 'warn' ? s.toneWarn : visual.tone === 'accent' ? s.toneAccent : undefined;

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={cx(s.pill, toneClass)}
        data-state={visual.state}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={visual.state === 'idle' ? `Last synced ${lastAgo}` : visual.word}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={s.icon} aria-hidden="true">
          {visual.icon}
        </span>
        <span className={s.text}>{visual.word}</span>
        {pendingCount > 0 && failedCount === 0 ? (
          <span className={s.badge} aria-hidden="true">
            {pendingCount}
          </span>
        ) : null}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" label="Sync status">
        <div className={s.panel}>
          <div className={s.summary}>
            <span className={s.headline}>{visual.word}</span>
            <span className={s.meta}>Last synced {lastAgo}</span>
            <span className={s.meta}>
              {pendingCount === 0 ? 'No pending changes' : `${pendingCount} pending ${pendingCount === 1 ? 'change' : 'changes'}`}
              {failedCount > 0 ? ` · ${failedCount} failed` : ''}
            </span>
          </div>

          {sync?.errorMessage ? <div className={s.errorBox}>{sync.errorMessage}</div> : null}

          <div className={s.divider} />

          <div className={s.actions}>
            {reauth ? (
              <button
                type="button"
                className={s.actionBtn}
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  void run(() => call('auth:signIn'), 'Sign-in failed');
                }}
              >
                <span className={s.actionIcon} aria-hidden="true">
                  <IconSignOut size={14} />
                </span>
                Sign in with Google
              </button>
            ) : null}

            <button
              type="button"
              className={s.actionBtn}
              disabled={busy || status === 'syncing'}
              onClick={() => {
                setOpen(false);
                void run(() => call('sync:now'), 'Sync failed');
              }}
            >
              <span className={s.actionIcon} aria-hidden="true">
                <IconRefresh size={14} />
              </span>
              Sync now
            </button>

            {unsynced > 0 ? (
              <button
                type="button"
                className={s.actionBtn}
                onClick={() => {
                  setOpen(false);
                  openOverlay('outbox');
                }}
              >
                <span className={s.actionIcon} aria-hidden="true">
                  <IconList size={14} />
                </span>
                Review {unsynced} unsynced {unsynced === 1 ? 'change' : 'changes'}
              </button>
            ) : null}

            <button
              type="button"
              className={s.actionBtn}
              disabled={busy || status === 'syncing'}
              onClick={() => {
                setOpen(false);
                void run(() => call('sync:now', { full: true }), 'Full resync failed');
              }}
            >
              <span className={s.actionIcon} aria-hidden="true">
                <IconRefresh size={14} />
              </span>
              Full resync
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}
