import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { GithubSearchResult, GithubState } from '@shared/models';
import { canonicalGithubUrl, parseGithubUrl, shortGithubLabel } from '@shared/github-url';
import { formatAgo } from '@shared/date/format';
import { Button } from '../../components/Button';
import { IconGithub, IconSearch } from '../../components/icons';
import { Kbd } from '../../components/Kbd';
import { call, IpcCallError } from '../../lib/ipc';
import { announce } from '../../lib/announce';
import { useStore } from '../../store/store';
import { GithubStateGlyph } from './glyphs';
import s from './github.module.css';

type Scope = 'involves' | 'assigned' | 'created' | 'repo';

const QUALIFIER: Record<Scope, string> = {
  involves: 'involves:@me', assigned: 'assignee:@me', created: 'author:@me', repo: '',
};

const REPO_TOKEN_RE = /(?:^|\s)([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)(?:\s|$)/;

interface PickerPayload { taskId?: unknown }
interface Row { url: string; label: string; title: string; meta: string; state: GithubState }

function repoIn(q: string): string | null {
  return REPO_TOKEN_RE.exec(q.trim())?.[1] ?? null;
}

/**
 * ⌘⇧G. Palette-style search over your issues and PRs; a pasted link is
 * recognised client-side with the same parser main uses, so it works offline
 * and without a token.
 */
export function GithubPickerOverlay(): ReactElement | null {
  const overlay = useStore((st) => st.overlay);
  const payload = useStore((st) => st.overlayPayload);
  if (overlay !== 'github-picker') return null;
  const taskId = ((payload as PickerPayload | null)?.taskId ?? null) as string | null;
  // Keyed so every open starts from a clean slate instead of resetting via an effect.
  return <Picker key={taskId ?? 'none'} taskId={taskId} />;
}

function Picker({ taskId }: { taskId: string | null }): ReactElement {
  const closeOverlay = useStore((st) => st.closeOverlay);
  const openOverlay = useStore((st) => st.openOverlay);
  const toast = useStore((st) => st.toast);

  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>('involves');
  const [results, setResults] = useState<GithubSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noToken, setNoToken] = useState(false);
  const [active, setActive] = useState(0);
  const [linking, setLinking] = useState(false);
  const seq = useRef(0);

  const pastedRef = useMemo(() => parseGithubUrl(q.trim()), [q]);
  const repo = useMemo(() => repoIn(q), [q]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const st = await call('github:getStatus').catch(() => null);
      if (alive && st !== null) setNoToken(!st.connected);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (noToken || pastedRef !== null) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      const sent = [QUALIFIER[scope], q.trim()].filter((p) => p !== '').join(' ');
      setLoading(true);
      void call('github:search', { q: sent, limit: 20 })
        .then((items) => {
          if (seq.current !== id) return;
          setResults(items);
          setActive(0);
          setError(null);
        })
        .catch((e: unknown) => {
          if (seq.current !== id) return;
          setResults([]);
          if (e instanceof IpcCallError && e.error.details?.['reason'] === 'no_token') setNoToken(true);
          else setError(e instanceof IpcCallError ? e.error.message : 'GitHub search failed.');
        })
        .finally(() => { if (seq.current === id) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); };
  }, [q, scope, noToken, pastedRef]);

  const link = useCallback(
    async (url: string, label: string): Promise<void> => {
      if (taskId === null) return;
      setLinking(true);
      try {
        await call('github:link', { taskId, url });
        closeOverlay();
        announce(`Linked ${label}`);
        toast({ level: 'success', message: `Linked ${label}` });
      } catch (e) {
        setError(e instanceof IpcCallError ? e.error.message : 'Could not link that item.');
      } finally {
        setLinking(false);
      }
    },
    [taskId, closeOverlay, toast],
  );

  const rows: Row[] = pastedRef !== null
    ? [{
        url: canonicalGithubUrl(pastedRef),
        label: shortGithubLabel(pastedRef),
        title: `Link ${shortGithubLabel(pastedRef)}`,
        meta: pastedRef.type === 'pull' ? 'Pull request from the pasted link' : 'Issue from the pasted link',
        state: 'open',
      }]
    : results.map((r) => ({
        url: r.url,
        label: `${r.owner}/${r.repo}#${r.number}`,
        title: r.title,
        meta: `${r.owner}/${r.repo}#${r.number}${r.author === '' ? '' : ` · @${r.author}`} · updated ${formatAgo(r.updatedAt)}`,
        state: r.state,
      }));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) void link(row.url, row.label);
    }
  };

  const busyText = loading && pastedRef === null ? 'Searching GitHub…' : null;

  return (
    <div className={s.scrim} onMouseDown={() => { closeOverlay(); }}>
      <div
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Link a GitHub issue or pull request"
        data-testid="gh-picker"
        onMouseDown={(e) => { e.stopPropagation(); }}
        onKeyDown={onKeyDown}
      >
        <div className={s.searchRow}>
          <IconSearch />
          <input
            className={s.searchInput}
            type="text"
            autoFocus
            spellCheck={false}
            placeholder="Search your issues and pull requests, or paste a link"
            aria-label="Search GitHub"
            value={q}
            onChange={(e) => { setQ(e.target.value); }}
          />
        </div>

        {noToken ? (
          <div className={s.empty} data-testid="gh-picker-no-token">
            <p>
              <IconGithub /> Connect GitHub to search your issues and pull requests. You can still paste a
              link — it is saved without status until you connect.
            </p>
            <Button variant="primary" size="sm" onClick={() => { openOverlay('settings', { section: 'github' }); }}>
              Connect GitHub
            </Button>
          </div>
        ) : (
          <div className={s.pills} role="group" aria-label="Filter">
            <button type="button" className={s.pill} aria-pressed={scope === 'involves'} onClick={() => { setScope('involves'); }}>Involves me</button>
            <button type="button" className={s.pill} aria-pressed={scope === 'assigned'} onClick={() => { setScope('assigned'); }}>Assigned</button>
            <button type="button" className={s.pill} aria-pressed={scope === 'created'} onClick={() => { setScope('created'); }}>Created</button>
            {repo !== null ? (
              <button type="button" className={s.pill} aria-pressed={scope === 'repo'} onClick={() => { setScope('repo'); }}>{`All in ${repo}`}</button>
            ) : null}
          </div>
        )}

        {error !== null ? <div className={s.empty} role="alert" data-testid="gh-picker-error">{error}</div> : null}

        {rows.length > 0 ? (
          <ul className={s.results} role="listbox" aria-label="Results">
            {rows.map((r, i) => (
              <li
                key={r.url}
                role="option"
                aria-selected={i === active}
                className={[s.result, i === active ? s.resultActive : ''].filter(Boolean).join(' ')}
                onMouseMove={() => { setActive(i); }}
                onClick={() => void link(r.url, r.label)}
              >
                <GithubStateGlyph kind={r.state} />
                <span className={s.resultMain}>
                  <span className={s.resultTitle}>{r.title}</span>
                  <span className={s.resultMeta}>{r.meta}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : error === null && !noToken ? (
          <div className={s.empty}>
            {busyText ?? (q.trim() === '' ? 'Start typing to search your open issues and pull requests.' : 'No matching issues or pull requests.')}
          </div>
        ) : null}

        <div className={s.footer}>
          <Kbd keys="↑" />
          <Kbd keys="↓" /> to move · <Kbd keys="Enter" /> to link · <Kbd keys="Esc" /> to close
          {linking ? ' · linking…' : ''}
        </div>
      </div>
    </div>
  );
}
