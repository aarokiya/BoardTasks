import { BrowserWindow } from 'electron';
import type { GithubLink, GithubLinkError, GithubSearchResult, GithubStatus, Task } from '@shared/models';
import { canonicalGithubUrl, parseGithubUrl } from '@shared/github-url';
import { createLogger } from '../logger';
import { nowIso } from '../util/time';
import { AppError } from '../ipc/errors';
import { emit, emitDataChanged } from '../ipc/emitter';
import { getTask } from '../db/repositories/tasks';
import { deleteLink, getLink, listAll, listStale, recordLinkError, upsertLink, type LinkEnrichment } from '../db/repositories/github-links';
import { createGithubApi, GithubApiError, parseRepoAndNumber, type FetchFn, type GithubApi } from './api';
import { installGithubHooks } from './hooks';
import { deleteGithubToken, loadGithubToken, saveGithubToken, tokenHint } from './token-store';

const log = createLogger('github');

/** A link older than this is refreshed by the background sweep. */
export const STALE_MS = 30 * 60 * 1000;
/** Sweep cadence while a window is focused. */
export const SWEEP_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;

export interface GithubServiceDeps {
  /** Electron `net.fetch` in production. */
  fetch: FetchFn;
  baseUrl?: string | null;
  /** GitHub Enterprise host accepted by the URL parser, in addition to github.com. */
  host?: string | null;
  isFocused?: () => boolean;
  now?: () => number;
  /** Background tick interval; 0 disables timers (tests). */
  tickMs?: number;
}

export interface GithubService {
  status(): Promise<GithubStatus>;
  setToken(token: string): Promise<GithubStatus>;
  clearToken(): GithubStatus;
  link(taskId: string, url: string): Promise<GithubLink>;
  unlink(taskId: string): void;
  refresh(target: { taskId: string } | { all: true }): Promise<GithubLink[]>;
  search(q: string, limit: number): Promise<GithubSearchResult[]>;
  /** Refresh stale links now if a window is focused (call on window focus). */
  onWindowFocus(): void;
  start(): void;
  stop(): void;
  /** Resolves once background enrichment has settled. Used by tests and shutdown. */
  drain(): Promise<void>;
}

const EMPTY_ENRICHMENT: LinkEnrichment = {
  title: null, state: null, author: null, authorAvatarUrl: null, labels: [],
  checks: null, reviewDecision: null, remoteUpdatedAt: null,
};

function toAppError(e: unknown, fallback: string): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof GithubApiError) {
    switch (e.kind) {
      case 'unauthorized': return new AppError('UNAUTHENTICATED', 'GitHub rejected this token', { details: { reason: 'unauthorized' } });
      case 'forbidden': return new AppError('FORBIDDEN', 'This token cannot access that repository.', { details: { reason: 'forbidden' } });
      case 'not_found': return new AppError('NOT_FOUND', 'That issue or pull request was not found.', { details: { reason: 'not_found' } });
      case 'rate_limited': return new AppError('RATE_LIMITED', 'GitHub rate limit reached. Status updates resume shortly.', { retryable: true, details: { reason: 'rate_limited', resetAt: e.resetAt ?? '' } });
      case 'no_token': return new AppError('UNAUTHENTICATED', 'Connect GitHub to use this.', { details: { reason: 'no_token' } });
      default: return new AppError('NETWORK', 'Could not reach GitHub.', { retryable: true, details: { reason: 'network' } });
    }
  }
  return new AppError('INTERNAL', fallback, { cause: e });
}

export function createGithubService(deps: GithubServiceDeps): GithubService {
  const now = deps.now ?? ((): number => Date.now());
  const isFocused = deps.isFocused ?? ((): boolean => BrowserWindow.getFocusedWindow() !== null);
  const tickMs = deps.tickMs ?? TICK_MS;
  const enterpriseHost = deps.host ?? undefined;

  let tokenCache: string | null | undefined;
  let login: string | null = null;
  let scopes: string[] = [];
  let lastError: GithubLinkError | null = null;
  let rateLimitedUntil: string | null = null;
  let verifying: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastFocused = false;
  let lastSweep = 0;
  const inflight = new Set<Promise<unknown>>();

  const token = (): string | null => {
    if (tokenCache === undefined) tokenCache = loadGithubToken();
    return tokenCache;
  };

  const api: GithubApi = createGithubApi({
    fetch: deps.fetch,
    baseUrl: deps.baseUrl ?? null,
    getToken: token,
    logger: log,
  });

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p);
    void p.catch(() => undefined).finally(() => inflight.delete(p));
    return p;
  }

  function isRateLimited(): boolean {
    if (rateLimitedUntil === null) return false;
    if (Date.parse(rateLimitedUntil) <= now()) {
      rateLimitedUntil = null;
      return false;
    }
    return true;
  }

  function emitLink(link: GithubLink): void {
    emit({ type: 'github:linkChanged', link });
    const task = getTask(link.taskId);
    if (task) emitDataChanged({ reason: 'github', tasks: [task] });
  }

  function emitTask(taskId: string): Task | null {
    const task = getTask(taskId);
    if (task) emitDataChanged({ reason: 'github', tasks: [task] });
    return task;
  }

  function noteError(kind: GithubLinkError, resetAt: string | null): void {
    lastError = kind;
    if (kind === 'rate_limited') rateLimitedUntil = resetAt ?? new Date(now() + 60_000).toISOString();
    if (kind === 'unauthorized') login = null;
  }

  /** Fetch one link's status. Never throws: failures are recorded on the row. */
  async function enrichOne(link: GithubLink): Promise<GithubLink> {
    try {
      const item = await api.getIssueOrPull(link.owner, link.repo, link.number);
      const ref = { host: link.host, owner: link.owner, repo: link.repo, type: item.type, number: link.number };
      lastError = null;
      return upsertLink(link.taskId, { ...ref, url: canonicalGithubUrl(ref) }, {
        type: item.type,
        title: item.title,
        state: item.state,
        author: item.author,
        authorAvatarUrl: item.authorAvatarUrl,
        labels: item.labels,
        checks: item.checks,
        reviewDecision: item.reviewDecision,
        remoteUpdatedAt: item.updatedAt,
        fetchedAt: nowIso(),
        error: null,
      });
    } catch (e) {
      const kind: GithubLinkError = e instanceof GithubApiError ? e.kind : 'network';
      noteError(kind, e instanceof GithubApiError ? e.resetAt : null);
      log.warn(`refresh failed for ${link.owner}/${link.repo}#${link.number}: ${kind}`);
      return recordLinkError(link.taskId, kind) ?? { ...link, error: kind };
    }
  }

  async function enrichAndEmit(link: GithubLink): Promise<GithubLink> {
    const updated = await enrichOne(link);
    emitLink(updated);
    return updated;
  }

  async function verify(): Promise<void> {
    if (verifying) return verifying;
    verifying = (async () => {
      try {
        const v = await api.viewer();
        login = v.login;
        scopes = v.scopes;
        lastError = null;
      } catch (e) {
        const kind: GithubLinkError = e instanceof GithubApiError ? e.kind : 'network';
        noteError(kind, e instanceof GithubApiError ? e.resetAt : null);
      } finally {
        verifying = null;
      }
    })();
    return verifying;
  }

  async function status(): Promise<GithubStatus> {
    const tok = token();
    if (tok === null) {
      return { connected: false, login: null, tokenHint: null, scopes: [], rateLimitRemaining: null, rateLimitResetAt: null, error: null };
    }
    if (login === null && lastError !== 'unauthorized') await verify();
    const rl = api.rateLimit();
    return {
      connected: true,
      login,
      tokenHint: tokenHint(tok),
      scopes,
      rateLimitRemaining: rl.remaining,
      rateLimitResetAt: rl.resetAt ?? rateLimitedUntil,
      error: lastError,
    };
  }

  async function setToken(raw: string): Promise<GithubStatus> {
    const t = raw.trim();
    if (t.length < 20) throw new AppError('VALIDATION', 'That does not look like a GitHub token.');
    const probe = createGithubApi({ fetch: deps.fetch, baseUrl: deps.baseUrl ?? null, getToken: () => t, logger: log });
    let viewer;
    try {
      viewer = await probe.viewer();
    } catch (e) {
      throw toAppError(e, 'Could not verify the GitHub token.');
    }
    saveGithubToken(t);
    tokenCache = t;
    login = viewer.login;
    scopes = viewer.scopes;
    lastError = null;
    rateLimitedUntil = null;
    log.info(`connected as ${viewer.login}`);
    // Links parked on 'no_token' can now be enriched.
    void track(refresh({ all: true }).catch(() => []));
    return status();
  }

  function clearToken(): GithubStatus {
    deleteGithubToken();
    tokenCache = null;
    login = null;
    scopes = [];
    lastError = null;
    rateLimitedUntil = null;
    for (const l of listAll()) {
      if (l.error !== 'no_token') {
        const updated = recordLinkError(l.taskId, 'no_token', null);
        if (updated) emitLink(updated);
      }
    }
    return { connected: false, login: null, tokenHint: null, scopes: [], rateLimitRemaining: null, rateLimitResetAt: null, error: null };
  }

  /**
   * Resolves as soon as the reference is stored, so the chip appears instantly;
   * enrichment continues in the background and pushes a second update.
   */
  function link(taskId: string, url: string): Promise<GithubLink> {
    try {
      return Promise.resolve(linkNow(taskId, url));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  function linkNow(taskId: string, url: string): GithubLink {
    const ref = parseGithubUrl(url, enterpriseHost === undefined ? undefined : { host: enterpriseHost });
    if (!ref) throw new AppError('VALIDATION', 'That is not a GitHub issue or pull request link.');
    if (!getTask(taskId)) throw new AppError('NOT_FOUND', 'Task not found.');
    const existing = getLink(taskId);
    const sameItem =
      existing !== null && existing.host === ref.host && existing.owner === ref.owner &&
      existing.repo === ref.repo && existing.number === ref.number;
    const tok = token();
    const fresh = upsertLink(taskId, { ...ref, url: canonicalGithubUrl(ref) }, {
      ...(sameItem ? {} : EMPTY_ENRICHMENT),
      fetchedAt: sameItem ? existing.fetchedAt : null,
      error: tok === null ? 'no_token' : null,
    });
    emitLink(fresh);
    if (tok !== null && !isRateLimited()) void track(enrichAndEmit(fresh).catch(() => fresh));
    return fresh;
  }

  function unlink(taskId: string): void {
    if (deleteLink(taskId)) emitTask(taskId);
  }

  async function refresh(target: { taskId: string } | { all: true }): Promise<GithubLink[]> {
    const links = 'all' in target ? listAll() : ((): GithubLink[] => {
      const l = getLink(target.taskId);
      return l ? [l] : [];
    })();
    const out: GithubLink[] = [];
    for (const l of links) {
      if (token() === null) {
        const updated = l.error === 'no_token' ? l : (recordLinkError(l.taskId, 'no_token', null) ?? l);
        if (updated !== l) emitLink(updated);
        out.push(updated);
        continue;
      }
      if (isRateLimited()) {
        const updated = l.error === 'rate_limited' ? l : (recordLinkError(l.taskId, 'rate_limited', l.fetchedAt) ?? l);
        if (updated !== l) emitLink(updated);
        out.push(updated);
        continue;
      }
      out.push(await enrichAndEmit(l));
    }
    return out;
  }

  /** `owner/repo 123` is a lookup, not a search — GitHub search cannot match on number. */
  async function byNumber(q: string): Promise<GithubSearchResult[] | null> {
    const direct = parseRepoAndNumber(q);
    if (!direct) return null;
    try {
      const item = await api.getIssueOrPull(direct.owner, direct.repo, direct.number);
      return [{
        url: item.url, owner: direct.owner, repo: direct.repo, type: item.type, number: item.number,
        title: item.title, state: item.state, author: item.author ?? '', updatedAt: item.updatedAt ?? '',
      }];
    } catch (e) {
      if (e instanceof GithubApiError && (e.kind === 'unauthorized' || e.kind === 'rate_limited')) throw e;
      return null; // fall back to a normal search
    }
  }

  async function search(q: string, limit: number): Promise<GithubSearchResult[]> {
    if (token() === null) throw new AppError('UNAUTHENTICATED', 'Connect GitHub to search issues and pull requests.', { details: { reason: 'no_token' } });
    try {
      const direct = await byNumber(q);
      if (direct !== null) return direct;
      return await api.search(q, limit);
    } catch (e) {
      if (e instanceof GithubApiError) noteError(e.kind, e.resetAt);
      throw toAppError(e, 'GitHub search failed.');
    }
  }

  async function sweep(): Promise<void> {
    let stale: GithubLink[];
    try {
      stale = listStale(STALE_MS, now());
    } catch (e) {
      log.warn('stale sweep skipped', e);
      return;
    }
    for (const l of stale) {
      if (isRateLimited() || token() === null) return;
      await enrichAndEmit(l);
    }
  }

  function maybeSweep(force: boolean): void {
    if (token() === null || isRateLimited()) return;
    if (!force && now() - lastSweep < SWEEP_MS) return;
    lastSweep = now();
    void track(sweep());
  }

  function tick(): void {
    const focused = isFocused();
    const gainedFocus = focused && !lastFocused;
    lastFocused = focused;
    if (!focused) return;
    maybeSweep(gainedFocus);
  }

  return {
    status,
    setToken,
    clearToken,
    link,
    unlink,
    refresh,
    search,
    onWindowFocus() {
      lastFocused = true;
      maybeSweep(true);
    },
    start() {
      if (timer !== null || tickMs <= 0) return;
      lastFocused = isFocused();
      timer = setInterval(tick, tickMs);
      timer.unref();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    async drain() {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}

let instance: GithubService | null = null;

/**
 * Create the service, install the task-creation hook, and start the background
 * refresh. Call once from bootstrap with Electron's `net.fetch`.
 */
export function initGithubService(deps: GithubServiceDeps): GithubService {
  instance?.stop();
  const svc = createGithubService(deps);
  instance = svc;
  installGithubHooks({
    linkUrl: async (taskId: string, url: string): Promise<Task | null> => {
      await svc.link(taskId, url);
      return getTask(taskId);
    },
  });
  svc.start();
  return svc;
}

export function getGithubService(): GithubService | null {
  return instance;
}

export function disposeGithubService(): void {
  instance?.stop();
  instance = null;
}
