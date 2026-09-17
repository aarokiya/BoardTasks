/**
 * GitHub REST client. Pure dependency injection: the caller supplies `fetch`
 * (Electron `net.fetch` in production so proxies / enterprise CA roots work,
 * a fake in tests). This module must never import `electron` at the top level —
 * it is exercised directly by unit tests in a plain node environment.
 */
import { GITHUB_API_BASE_URL } from '@shared/constants';
import type {
  GithubChecks,
  GithubItemType,
  GithubLinkError,
  GithubReview,
  GithubSearchResult,
  GithubState,
} from '@shared/models';
import { parseGithubUrl } from '@shared/github-url';
import type { Logger } from '../logger';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface RateLimit {
  remaining: number | null;
  resetAt: string | null;
}

/** Every failure the client can produce, already mapped to a UI-facing kind. */
export class GithubApiError extends Error {
  constructor(
    readonly kind: GithubLinkError,
    message: string,
    readonly status: number | null = null,
    readonly resetAt: string | null = null,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

export interface GithubViewer {
  login: string;
  /** Empty for fine-grained tokens — GitHub omits X-OAuth-Scopes for them. */
  scopes: string[];
}

export interface GithubItem {
  type: GithubItemType;
  number: number;
  title: string;
  state: GithubState;
  author: string | null;
  authorAvatarUrl: string | null;
  labels: Array<{ name: string; color: string }>;
  checks: GithubChecks | null;
  reviewDecision: GithubReview | null;
  /** Null when GitHub has not computed it yet. Not persisted (no column). */
  mergeable: boolean | null;
  updatedAt: string | null;
  url: string;
}

export interface GithubApi {
  viewer(): Promise<GithubViewer>;
  getIssueOrPull(owner: string, repo: string, number: number): Promise<GithubItem>;
  search(q: string, limit: number): Promise<GithubSearchResult[]>;
  rateLimit(): RateLimit;
}

export interface GithubApiDeps {
  fetch: FetchFn;
  baseUrl?: string | null;
  getToken: () => string | null;
  logger?: Logger;
  timeoutMs?: number;
}

// ---- wire shapes (every field optional: never trust the response) ----

interface UserDto { login?: string; avatar_url?: string }
interface LabelDto { name?: string; color?: string }
interface IssueDto {
  number?: number;
  title?: string;
  state?: string;
  user?: UserDto | null;
  labels?: LabelDto[];
  updated_at?: string;
  html_url?: string;
  draft?: boolean;
  repository_url?: string;
  pull_request?: { merged_at?: string | null; html_url?: string } | null;
}
interface PullDto {
  merged?: boolean;
  draft?: boolean;
  state?: string;
  merged_at?: string | null;
  mergeable?: boolean | null;
  updated_at?: string;
  head?: { sha?: string } | null;
}
interface CheckRunsDto { check_runs?: Array<{ status?: string; conclusion?: string | null }> }
interface ReviewDto { user?: UserDto | null; state?: string; submitted_at?: string | null }
interface SearchDto { items?: IssueDto[] }

const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 15_000;

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/** Roll a PR's check runs up to one of four states. Failure beats pending beats success. */
export function rollupChecks(runs: Array<{ status?: string; conclusion?: string | null }>): GithubChecks | null {
  if (runs.length === 0) return null;
  let pending = false;
  let success = false;
  for (const r of runs) {
    const conclusion = r.conclusion ?? null;
    if (r.status !== 'completed') { pending = true; continue; }
    if (conclusion !== null && FAILING.has(conclusion)) return 'failure';
    if (conclusion === 'success') success = true;
  }
  if (pending) return 'pending';
  if (success) return 'success';
  return 'neutral';
}

/**
 * Latest decisive review per reviewer: any outstanding CHANGES_REQUESTED wins,
 * otherwise any APPROVED, otherwise the PR still needs a review.
 */
export function rollupReviews(reviews: ReviewDto[]): GithubReview {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    const login = r.user?.login;
    const state = r.state;
    if (!login || !state) continue;
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') continue;
    latest.set(login, state);
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return 'review_required';
}

const QUALIFIER_RE = /\b(?:involves|assignee|author|mentions|repo|org|user|commenter):/i;
const REPO_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Turn what the user typed into a GitHub search query.
 * Defaults to open items involving the viewer; a bare `owner/repo` token
 * narrows to that repository; explicit qualifiers are never second-guessed.
 */
export function buildSearchQuery(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter((t) => t !== '');
  const parts: string[] = [];
  const free: string[] = [];
  let hasRepo = false;
  for (const t of tokens) {
    if (!QUALIFIER_RE.test(t) && REPO_TOKEN_RE.test(t)) {
      parts.push(`repo:${t}`);
      hasRepo = true;
      continue;
    }
    free.push(t);
  }
  const text = free.join(' ');
  const hasQualifier = QUALIFIER_RE.test(text) || hasRepo;
  const out = [...parts];
  if (!/\bis:(open|closed|merged)\b/i.test(text)) out.push('is:open');
  if (!hasQualifier) out.push('involves:@me');
  if (text !== '') out.push(text);
  return out.join(' ');
}

const REPO_NUMBER_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\s*#?\s*(\d{1,10})$/;

/**
 * `owner/repo 123` or `owner/repo#123` — a direct reference rather than a
 * search. GitHub search cannot look an item up by number, so the caller
 * resolves these against the issues endpoint instead.
 */
export function parseRepoAndNumber(raw: string): { owner: string; repo: string; number: number } | null {
  const m = REPO_NUMBER_RE.exec(raw.trim());
  if (!m) return null;
  const [, owner, repo, num] = m;
  const number = Number(num);
  if (!owner || !repo || number <= 0) return null;
  return { owner, repo, number };
}

/**
 * Defence in depth on path building. `owner`/`repo` are regex-validated by the
 * URL parser before they reach the database, but they arrive here from a stored
 * row, and a path segment that could carry `../` or `?` would let a crafted
 * link re-point an authenticated, token-bearing request at another endpoint.
 */
function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

function headerInt(res: Response, name: string): number | null {
  const v = res.headers.get(name);
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function searchItemToResult(item: IssueDto): GithubSearchResult | null {
  const html = item.html_url ?? '';
  const ref = parseGithubUrl(html);
  if (!ref || typeof item.number !== 'number') return null;
  const isPull = item.pull_request != null || ref.type === 'pull';
  const merged = item.pull_request?.merged_at != null;
  const state: GithubState = merged
    ? 'merged'
    : isPull && item.draft === true && item.state !== 'closed'
      ? 'draft'
      : item.state === 'closed'
        ? 'closed'
        : 'open';
  return {
    url: html,
    owner: ref.owner,
    repo: ref.repo,
    type: isPull ? 'pull' : 'issue',
    number: item.number,
    title: item.title ?? `#${item.number}`,
    state,
    author: item.user?.login ?? '',
    updatedAt: item.updated_at ?? '',
  };
}

export function createGithubApi(deps: GithubApiDeps): GithubApi {
  // The one place the PAT is attached to a request. `base` is fixed at
  // construction from a constant or a dev-only env override — never from a
  // pasted URL or a stored link's host — so the token cannot follow a
  // user-supplied hostname off to somebody else's server.
  const base = (deps.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = deps.logger;
  let limit: RateLimit = { remaining: null, resetAt: null };

  function captureRateLimit(res: Response): void {
    const remaining = headerInt(res, 'x-ratelimit-remaining');
    const reset = headerInt(res, 'x-ratelimit-reset');
    limit = {
      remaining: remaining ?? limit.remaining,
      resetAt: reset === null ? limit.resetAt : new Date(reset * 1000).toISOString(),
    };
  }

  function mapStatus(res: Response, path: string): GithubApiError {
    const status = res.status;
    const retryAfter = headerInt(res, 'retry-after');
    if (status === 401) return new GithubApiError('unauthorized', 'GitHub rejected this token.', status);
    if (status === 403 || status === 429) {
      const remaining = headerInt(res, 'x-ratelimit-remaining');
      if (remaining === 0 || status === 429 || retryAfter !== null) {
        const resetAt = retryAfter !== null ? new Date(Date.now() + retryAfter * 1000).toISOString() : limit.resetAt;
        return new GithubApiError('rate_limited', 'GitHub rate limit reached.', status, resetAt);
      }
      return new GithubApiError('forbidden', 'This token cannot access that repository.', status);
    }
    if (status === 404) return new GithubApiError('not_found', 'That issue or pull request was not found.', status);
    log?.warn(`unexpected ${status} from ${path}`);
    return new GithubApiError('network', `GitHub responded with ${status}.`, status);
  }

  async function request<T>(path: string): Promise<{ body: T; res: Response }> {
    const token = deps.getToken();
    if (token === null || token === '') throw new GithubApiError('no_token', 'No GitHub token is configured.');
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    let res: Response;
    try {
      res = await deps.fetch(`${base}${path}`, {
        method: 'GET',
        headers: {
          Accept: ACCEPT,
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'BoardTasks',
        },
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = controller.signal.aborted;
      log?.warn(`request failed ${path}`, e);
      throw new GithubApiError('network', aborted ? 'GitHub did not respond in time.' : 'Could not reach GitHub.');
    } finally {
      clearTimeout(timer);
    }
    captureRateLimit(res);
    if (!res.ok) throw mapStatus(res, path);
    const raw: unknown = await res.json().catch(() => null);
    return { body: raw as T, res };
  }

  /** Sub-requests that enrich a PR must not sink the whole refresh; auth/limit problems still propagate. */
  async function optional<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GithubApiError && (e.kind === 'unauthorized' || e.kind === 'rate_limited')) throw e;
      log?.debug('optional GitHub sub-request failed', e);
      return fallback;
    }
  }

  return {
    rateLimit: () => limit,

    async viewer(): Promise<GithubViewer> {
      const { body, res } = await request<UserDto>('/user');
      const scopeHeader = res.headers.get('x-oauth-scopes') ?? '';
      return {
        login: body?.login ?? '',
        scopes: scopeHeader.split(',').map((s) => s.trim()).filter((s) => s !== ''),
      };
    },

    async getIssueOrPull(owner, repo, number): Promise<GithubItem> {
      const { body: issue } = await request<IssueDto>(`/repos/${seg(owner)}/${seg(repo)}/issues/${seg(number)}`);
      const labels = (issue?.labels ?? [])
        .map((l) => ({ name: l.name ?? '', color: (l.color ?? '').replace(/^#/, '') }))
        .filter((l) => l.name !== '');
      const item: GithubItem = {
        type: 'issue',
        number: issue?.number ?? number,
        title: issue?.title ?? `#${number}`,
        state: issue?.state === 'closed' ? 'closed' : 'open',
        author: issue?.user?.login ?? null,
        authorAvatarUrl: issue?.user?.avatar_url ?? null,
        labels,
        checks: null,
        reviewDecision: null,
        mergeable: null,
        updatedAt: issue?.updated_at ?? null,
        url: issue?.html_url ?? `https://github.com/${owner}/${repo}/issues/${number}`,
      };
      if (issue?.pull_request == null) return item;

      const { body: pull } = await request<PullDto>(`/repos/${seg(owner)}/${seg(repo)}/pulls/${seg(number)}`);
      item.type = 'pull';
      item.mergeable = pull?.mergeable ?? null;
      item.state = pull?.merged === true || pull?.merged_at != null
        ? 'merged'
        : pull?.draft === true && pull.state !== 'closed'
          ? 'draft'
          : pull?.state === 'closed'
            ? 'closed'
            : 'open';
      if (pull?.updated_at) item.updatedAt = pull.updated_at;
      if (issue.html_url) item.url = issue.html_url;

      const sha = pull?.head?.sha ?? null;
      if (sha !== null && sha !== '') {
        item.checks = await optional(async () => {
          const { body } = await request<CheckRunsDto>(`/repos/${seg(owner)}/${seg(repo)}/commits/${seg(sha)}/check-runs?per_page=100`);
          return rollupChecks(body?.check_runs ?? []);
        }, null);
      }
      if (item.state === 'open' || item.state === 'draft') {
        item.reviewDecision = await optional(async () => {
          const { body } = await request<ReviewDto[]>(`/repos/${seg(owner)}/${seg(repo)}/pulls/${seg(number)}/reviews?per_page=100`);
          return rollupReviews(Array.isArray(body) ? body : []);
        }, null);
      }
      return item;
    },

    async search(q, rawLimit): Promise<GithubSearchResult[]> {
      const perPage = Math.max(1, Math.min(50, Math.trunc(rawLimit)));
      const query = buildSearchQuery(q);
      const path = `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=updated&order=desc&advanced_search=true`;
      const { body } = await request<SearchDto>(path);
      const items = body?.items ?? [];
      const out: GithubSearchResult[] = [];
      for (const i of items) {
        const r = searchItemToResult(i);
        if (r) out.push(r);
      }
      return out;
    },
  };
}
