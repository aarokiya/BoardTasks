import { useEffect, useState, type ReactElement } from 'react';
import type { GithubStatus } from '@shared/models';
import { formatAgo } from '@shared/date/format';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { IconGithub } from '../../components/icons';
import { call, IpcCallError } from '../../lib/ipc';
import { NEW_TOKEN_URL, openOnGithub } from './actions';
import s from './github.module.css';

function rateLimitText(status: GithubStatus): string | null {
  if (status.rateLimitRemaining === null) return null;
  const resets = status.rateLimitResetAt === null ? '' : ` · resets ${formatAgo(status.rateLimitResetAt).replace(' ago', ' from now')}`;
  return `${status.rateLimitRemaining.toLocaleString()} API requests left${resets}`;
}

/**
 * Settings section for the fine-grained personal access token. The token never
 * reaches this component again after it is submitted — only its last 4 chars.
 */
export function GithubConnectSettings(): ReactElement {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read the connection once on mount; every later read is user-initiated.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = await call('github:getStatus').catch(() => null);
      if (!alive) return;
      if (next === null) setError('Could not read the GitHub connection.');
      else setStatus(next);
    })();
    return () => { alive = false; };
  }, []);

  const load = async (): Promise<GithubStatus | null> => {
    try {
      const next = await call('github:getStatus');
      setStatus(next);
      return next;
    } catch {
      setError('Could not read the GitHub connection.');
      return null;
    }
  };

  const connect = async (): Promise<void> => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const next = await call('github:setToken', { token: token.trim() });
      setStatus(next);
      setToken('');
      setNote(next.login === null ? 'Connected.' : `Connected as @${next.login}.`);
    } catch (e) {
      setError(e instanceof IpcCallError ? e.error.message : 'Could not connect to GitHub.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await call('github:clearToken'));
      setNote('Disconnected. Existing links keep their reference but stop updating.');
    } catch {
      setError('Could not disconnect.');
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const next = await load();
    setBusy(false);
    if (!next) return;
    if (next.error === null && next.login !== null) setNote(`GitHub answered as @${next.login}.`);
    else if (next.error === 'unauthorized') setError('GitHub rejected the saved token. Create a new one and connect again.');
    else if (next.error === 'rate_limited') setError('GitHub rate limit reached. Try again shortly.');
    else if (next.error !== null) setError('Could not reach GitHub.');
  };

  const limit = status === null ? null : rateLimitText(status);

  return (
    <section className={s.section} aria-labelledby="gh-settings-title" data-testid="gh-settings">
      <div className={s.sectionHead}>
        <IconGithub />
        <h3 className={s.sectionTitle} id="gh-settings-title">GitHub</h3>
      </div>

      {status?.connected === true ? (
        <>
          <div className={s.account}>
            <div>
              <div className={s.accountName}>{status.login === null ? 'Connected' : `@${status.login}`}</div>
              <div className={s.accountMeta}>
                Token ending …{status.tokenHint ?? '????'}
                {status.scopes.length > 0 ? ` · ${status.scopes.join(', ')}` : ' · fine-grained token'}
                {limit === null ? '' : ` · ${limit}`}
              </div>
            </div>
            <span className={s.cardSpacer} />
            <Button size="sm" onClick={() => void test()} disabled={busy}>Test connection</Button>
            <Button size="sm" variant="danger" onClick={() => void disconnect()} disabled={busy}>Disconnect</Button>
          </div>
          {note !== null ? <p className={s.ok}>{note}</p> : null}
          {error !== null ? <p className={s.error} role="alert">{error}</p> : null}
        </>
      ) : (
        <>
          <div className={s.help}>
            BoardTasks reads issue and pull-request status with a <strong>fine-grained personal access token</strong>.
            It never writes to GitHub and never leaves this Mac — it is stored encrypted in your keychain.
            <ol>
              <li>Create a token, choosing only the repositories you want to link.</li>
              <li>Under <em>Repository permissions</em>, set <strong>Issues</strong> and <strong>Pull requests</strong> to <em>Read-only</em>.</li>
              <li>Copy the token and paste it below.</li>
            </ol>
          </div>
          <p className={s.help}>
            <button type="button" className={s.linkBtn} onClick={() => void openOnGithub(NEW_TOKEN_URL)}>
              Create a token on GitHub ↗
            </button>
          </p>
          <div className={s.formRow}>
            <div className={s.formGrow}>
              <Input
                label="Personal access token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                mono
                placeholder="github_pat_…"
                value={token}
                error={error}
                onChange={(e) => { setToken(e.target.value); setError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && token.trim().length >= 20) void connect(); }}
              />
            </div>
            <Button variant="primary" onClick={() => void connect()} disabled={busy || token.trim().length < 20}>
              Connect
            </Button>
          </div>
          {note !== null ? <p className={s.ok}>{note}</p> : null}
        </>
      )}
    </section>
  );
}
