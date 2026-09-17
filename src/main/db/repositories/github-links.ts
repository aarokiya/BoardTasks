import type { GithubChecks, GithubItemType, GithubLink, GithubLinkError, GithubReview, GithubState } from '@shared/models';
import type { GithubRef } from '@shared/github-url';
import { getDb } from '../connection';
import { nowIso } from '../../util/time';
import { uuid } from '../../util/uuid';
import { rowToGithub, type GithubRow } from './mappers';

/**
 * One GitHub link per task (UNIQUE(task_id)). Enrichment is written separately
 * from the reference itself so a link shows `repo#123` the instant it is made,
 * before the network has said anything.
 */
export interface LinkEnrichment {
  type?: GithubItemType;
  title?: string | null;
  state?: GithubState | null;
  author?: string | null;
  authorAvatarUrl?: string | null;
  labels?: Array<{ name: string; color: string }>;
  checks?: GithubChecks | null;
  reviewDecision?: GithubReview | null;
  remoteUpdatedAt?: string | null;
  fetchedAt?: string | null;
  error?: GithubLinkError | null;
}

const SELECT = 'SELECT * FROM github_links';

/**
 * GitHub links are local-only (never synced to Google), so they bump the task's
 * rev without touching `local_updated_at` or `dirty_fields` — the renderer
 * refreshes, the sync engine sees nothing to push.
 */
function bumpTaskRev(taskId: string): void {
  getDb().prepare('UPDATE tasks SET rev = rev + 1 WHERE id = ?').run(taskId);
}

export function getLink(taskId: string): GithubLink | null {
  const row = getDb().prepare(`${SELECT} WHERE task_id = ?`).get(taskId) as GithubRow | undefined;
  return row ? rowToGithub(row) : null;
}

export function listAll(): GithubLink[] {
  return (getDb().prepare(`${SELECT} ORDER BY created_at`).all() as GithubRow[]).map(rowToGithub);
}

/** Links never fetched, or last fetched longer than `olderThanMs` ago. */
export function listStale(olderThanMs: number, now: number = Date.now()): GithubLink[] {
  const cutoff = new Date(now - olderThanMs).toISOString();
  const rows = getDb()
    .prepare(`${SELECT} WHERE fetched_at IS NULL OR fetched_at < ? ORDER BY fetched_at IS NOT NULL, fetched_at`)
    .all(cutoff) as GithubRow[];
  return rows.map(rowToGithub);
}

/**
 * Insert or replace the link for a task. `enrichment` fields that are omitted
 * keep their previous value, so a refresh failure never blanks a good title.
 */
export function upsertLink(taskId: string, ref: GithubRef & { url: string }, enrichment: LinkEnrichment = {}): GithubLink {
  const db = getDb();
  const existing = db.prepare(`${SELECT} WHERE task_id = ?`).get(taskId) as GithubRow | undefined;
  const now = nowIso();
  const e = enrichment;
  const has = <K extends keyof LinkEnrichment>(k: K): boolean => Object.prototype.hasOwnProperty.call(e, k);

  const next: GithubRow = {
    id: existing?.id ?? uuid(),
    task_id: taskId,
    url: ref.url,
    host: ref.host,
    owner: ref.owner,
    repo: ref.repo,
    type: e.type ?? ref.type,
    number: ref.number,
    title: has('title') ? (e.title ?? null) : (existing?.title ?? null),
    state: has('state') ? (e.state ?? null) : (existing?.state ?? null),
    author: has('author') ? (e.author ?? null) : (existing?.author ?? null),
    author_avatar_url: has('authorAvatarUrl') ? (e.authorAvatarUrl ?? null) : (existing?.author_avatar_url ?? null),
    labels_json: has('labels') ? JSON.stringify(e.labels ?? []) : (existing?.labels_json ?? '[]'),
    checks: has('checks') ? (e.checks ?? null) : (existing?.checks ?? null),
    review_decision: has('reviewDecision') ? (e.reviewDecision ?? null) : (existing?.review_decision ?? null),
    remote_updated_at: has('remoteUpdatedAt') ? (e.remoteUpdatedAt ?? null) : (existing?.remote_updated_at ?? null),
    fetched_at: has('fetchedAt') ? (e.fetchedAt ?? null) : (existing?.fetched_at ?? null),
    error: has('error') ? (e.error ?? null) : (existing?.error ?? null),
    created_at: existing?.created_at ?? now,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO github_links (id, task_id, url, host, owner, repo, type, number, title, state, author, author_avatar_url,
        labels_json, checks, review_decision, remote_updated_at, fetched_at, error, created_at)
       VALUES (@id, @task_id, @url, @host, @owner, @repo, @type, @number, @title, @state, @author, @author_avatar_url,
        @labels_json, @checks, @review_decision, @remote_updated_at, @fetched_at, @error, @created_at)
       ON CONFLICT(task_id) DO UPDATE SET
        url = excluded.url, host = excluded.host, owner = excluded.owner, repo = excluded.repo, type = excluded.type,
        number = excluded.number, title = excluded.title, state = excluded.state, author = excluded.author,
        author_avatar_url = excluded.author_avatar_url, labels_json = excluded.labels_json, checks = excluded.checks,
        review_decision = excluded.review_decision, remote_updated_at = excluded.remote_updated_at,
        fetched_at = excluded.fetched_at, error = excluded.error`,
    ).run(next);
    bumpTaskRev(taskId);
  })();
  return rowToGithub(next);
}

/** Record a failed enrichment without disturbing the fields we already have. */
export function recordLinkError(taskId: string, error: GithubLinkError, fetchedAt: string | null = nowIso()): GithubLink | null {
  const db = getDb();
  const existing = db.prepare(`${SELECT} WHERE task_id = ?`).get(taskId) as GithubRow | undefined;
  if (!existing) return null;
  db.transaction(() => {
    db.prepare('UPDATE github_links SET error = ?, fetched_at = ? WHERE task_id = ?').run(error, fetchedAt, taskId);
    bumpTaskRev(taskId);
  })();
  return getLink(taskId);
}

export function deleteLink(taskId: string): boolean {
  const db = getDb();
  let removed = false;
  db.transaction(() => {
    const info = db.prepare('DELETE FROM github_links WHERE task_id = ?').run(taskId);
    removed = info.changes > 0;
    if (removed) bumpTaskRev(taskId);
  })();
  return removed;
}
