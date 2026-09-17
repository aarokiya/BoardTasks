import { useState, type CSSProperties, type ReactElement } from 'react';
import type { GithubChecks, GithubLink, GithubLinkError, GithubReview, Task } from '@shared/models';
import { formatAgo } from '@shared/date/format';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { IconExternal, IconRefresh, IconTrash } from '../../components/icons';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { errorCopy, GithubStateGlyph, glyphFor, stateLabel } from './glyphs';
import { openOnGithub } from './actions';
import s from './github.module.css';

/** WCAG relative luminance, so a GitHub label colour gets readable text. */
function readableOn(hex: string): string {
  const raw = hex.replace(/^#/, '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return 'var(--bt-text-primary)';
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(full.slice(0, 2), 16));
  const g = channel(parseInt(full.slice(2, 4), 16));
  const b = channel(parseInt(full.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111418' : '#ffffff';
}

function labelStyle(color: string): CSSProperties {
  const hex = /^[0-9a-fA-F]{3,6}$/.test(color) ? `#${color}` : 'transparent';
  return {
    backgroundColor: hex,
    color: readableOn(color),
    borderColor: `color-mix(in srgb, ${hex} 72%, var(--bt-text-primary))`,
  };
}

const CHECK_LABEL: Record<GithubChecks, string> = {
  success: 'Checks passing', failure: 'Checks failing', pending: 'Checks running', neutral: 'Checks neutral',
};
const CHECK_KIND: Record<GithubChecks, string> = { success: 'success', failure: 'failure', pending: 'pending', neutral: 'neutral' };
const REVIEW_LABEL: Record<GithubReview, string> = {
  approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required',
};
const REVIEW_KIND: Record<GithubReview, string> = { approved: 'success', changes_requested: 'failure', review_required: 'neutral' };

const NEEDS_TOKEN = new Set<GithubLinkError>(['no_token', 'unauthorized', 'forbidden']);

function Notice({ link, onUnlink, onRetry, busy }: { link: GithubLink; onUnlink: () => void; onRetry: () => void; busy: boolean }): ReactElement | null {
  const openOverlay = useStore((st) => st.openOverlay);
  if (link.error === null) return null;
  const warn = link.error === 'unauthorized' || link.error === 'forbidden';
  return (
    <div className={[s.notice, warn ? s.noticeWarn : ''].filter(Boolean).join(' ')} role="status">
      <span>{errorCopy(link.error)}.</span>
      <div className={s.noticeActions}>
        {NEEDS_TOKEN.has(link.error) ? (
          <Button size="sm" onClick={() => { openOverlay('settings', { section: 'github' }); }}>
            {link.error === 'no_token' ? 'Connect GitHub…' : 'Update token…'}
          </Button>
        ) : null}
        {link.error === 'not_found' ? <Button size="sm" onClick={onUnlink}>Remove link</Button> : null}
        {link.error === 'network' || link.error === 'rate_limited' ? (
          <Button size="sm" onClick={onRetry} disabled={busy}>Try again</Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Detail-pane card for the linked issue / PR. Everything it shows comes from
 * the local row, so it renders instantly and identically while offline.
 */
export function GithubCard({ task }: { task: Task }): ReactElement | null {
  const link = task.github;
  const [busy, setBusy] = useState(false);
  const setStatus = useStore((st) => st.setStatus);
  const toast = useStore((st) => st.toast);
  if (!link) return null;

  const { kind, strike } = glyphFor(link);
  const ref = `${link.owner}/${link.repo} #${link.number}`;

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      await call('github:refresh', { taskId: task.id });
    } catch {
      toast({ level: 'error', message: 'Could not refresh from GitHub.' });
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (): Promise<void> => {
    try {
      await call('github:unlink', { taskId: task.id });
      useStore.setState((st) => {
        const cur = st.tasks[task.id];
        return cur ? { tasks: { ...st.tasks, [task.id]: { ...cur, github: null } }, version: st.version + 1 } : {};
      });
      toast({ level: 'success', message: 'GitHub link removed' });
    } catch {
      toast({ level: 'error', message: 'Could not remove the link.' });
    }
  };

  const closedish = link.state === 'merged' || link.state === 'closed';
  const timeWord = link.state === 'merged' ? 'merged' : link.state === 'closed' ? 'closed' : 'updated';

  return (
    <section className={s.card} aria-label="GitHub link" data-testid="gh-card">
      <div className={s.cardHead}>
        <GithubStateGlyph kind={kind} size={16} />
        <span className={s.cardRepo}>{ref}</span>
        <span className={s.cardSpacer} />
        <IconButton label="Refresh from GitHub" icon={<IconRefresh />} size="sm" onClick={() => void refresh()} disabled={busy} />
        <IconButton label="Open on GitHub" icon={<IconExternal />} size="sm" onClick={() => void openOnGithub(link.url)} />
        <IconButton label="Remove GitHub link" icon={<IconTrash />} size="sm" danger onClick={() => void unlink()} />
      </div>

      <h3 className={[s.cardTitle, strike ? s.chipGone : ''].filter(Boolean).join(' ')}>
        {link.title ?? `${link.type === 'pull' ? 'Pull request' : 'Issue'} #${link.number}`}
      </h3>
      <p className={s.cardMeta}>
        {link.author !== null && link.author !== '' ? `@${link.author} · ` : ''}
        {stateLabel(link.state)}
        {link.remoteUpdatedAt !== null ? ` · ${timeWord} ${formatAgo(link.remoteUpdatedAt)}` : ''}
      </p>

      {link.labels.length > 0 ? (
        <div className={s.cardRow}>
          {link.labels.map((l) => (
            <span key={l.name} className={s.label} style={labelStyle(l.color)}>{l.name}</span>
          ))}
        </div>
      ) : null}

      {link.type === 'pull' && (link.checks !== null || link.reviewDecision !== null) ? (
        <div className={s.cardRow}>
          {link.checks !== null ? (
            <span className={s.statusChip} data-kind={CHECK_KIND[link.checks]}>{CHECK_LABEL[link.checks]}</span>
          ) : null}
          {link.reviewDecision !== null ? (
            <span className={s.statusChip} data-kind={REVIEW_KIND[link.reviewDecision]}>{REVIEW_LABEL[link.reviewDecision]}</span>
          ) : null}
        </div>
      ) : null}

      <Notice link={link} onUnlink={() => void unlink()} onRetry={() => void refresh()} busy={busy} />

      {closedish && task.status !== 'completed' ? (
        <div className={s.suggest}>
          <span>{link.state === 'merged' ? 'Merged' : 'Closed'} — complete this task?</span>
          <Button size="sm" variant="primary" onClick={() => void setStatus([task.id], true)}>Complete</Button>
        </div>
      ) : null}

      <div className={s.cardFoot}>
        <span>{busy ? 'Refreshing…' : `Last refreshed ${formatAgo(link.fetchedAt)}`}</span>
        <span className={s.cardSpacer} />
        <Button size="sm" variant="ghost" onClick={() => void openOnGithub(link.url)}>Open ↗</Button>
      </div>
    </section>
  );
}
