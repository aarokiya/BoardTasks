import type { GithubLink, Task, TaskConflict, TaskList, TaskLink, SyncFlag } from '@shared/models';
import type { CivilDate } from '@shared/date/civil';

export interface TaskRow {
  id: string; remote_id: string | null; list_id: string; title: string; notes: string;
  status: 'needsAction' | 'completed'; due: string | null; due_time: string | null; completed_at: string | null;
  parent_id: string | null; position: string | null; sort_key: string; priority: number; flagged: number;
  hidden: number; deleted: number; remote_deleted: number; web_view_link: string | null; links_json: string;
  etag: string | null; updated_at: string | null; base_json: string | null; dirty_fields: string;
  conflict_json: string | null; created_at: string; local_updated_at: string; rev: number;
  pending_count?: number; parked_count?: number;
}

export interface ListRow {
  id: string; remote_id: string | null; title: string; color: string; position: number; is_default: number;
  deleted: number; etag: string | null; updated_at: string | null; local_updated_at: string; rev: number;
  pending_count?: number; parked_count?: number;
}

export interface GithubRow {
  id: string; task_id: string; url: string; host: string; owner: string; repo: string; type: 'issue' | 'pull';
  number: number; title: string | null; state: string | null; author: string | null; author_avatar_url: string | null;
  labels_json: string; checks: string | null; review_decision: string | null; remote_updated_at: string | null;
  fetched_at: string | null; error: string | null; created_at: string;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function syncFlag(row: { pending_count?: number; parked_count?: number; conflict_json?: string | null }): SyncFlag {
  if (row.conflict_json) return 'conflict';
  if ((row.parked_count ?? 0) > 0) return 'failed';
  if ((row.pending_count ?? 0) > 0) return 'pending';
  return 'synced';
}

export function rowToGithub(r: GithubRow): GithubLink {
  return {
    id: r.id, taskId: r.task_id, url: r.url, host: r.host, owner: r.owner, repo: r.repo, type: r.type, number: r.number,
    title: r.title, state: r.state as GithubLink['state'], author: r.author, authorAvatarUrl: r.author_avatar_url,
    labels: parseJson(r.labels_json, []), checks: r.checks as GithubLink['checks'],
    reviewDecision: r.review_decision as GithubLink['reviewDecision'], remoteUpdatedAt: r.remote_updated_at,
    fetchedAt: r.fetched_at, error: r.error as GithubLink['error'], createdAt: r.created_at,
  };
}

export function rowToTask(r: TaskRow, github: GithubLink | null = null): Task {
  return {
    id: r.id, remoteId: r.remote_id, listId: r.list_id, title: r.title, notes: r.notes, status: r.status,
    due: (r.due as CivilDate | null) ?? null, dueTime: r.due_time, completedAt: r.completed_at, parentId: r.parent_id,
    sortKey: r.sort_key, priority: r.priority as Task['priority'], flagged: r.flagged === 1, hidden: r.hidden === 1,
    deleted: r.deleted === 1, webViewLink: r.web_view_link, links: parseJson<TaskLink[]>(r.links_json, []), github,
    sync: syncFlag(r), conflict: parseJson<TaskConflict | null>(r.conflict_json, null), rev: r.rev,
    createdAt: r.created_at, updatedAt: r.updated_at, localUpdatedAt: r.local_updated_at,
  };
}

export function rowToList(r: ListRow): TaskList {
  return {
    id: r.id, remoteId: r.remote_id, title: r.title, color: r.color as TaskList['color'], position: r.position,
    isDefault: r.is_default === 1, sync: syncFlag(r), rev: r.rev, updatedAt: r.updated_at,
  };
}
