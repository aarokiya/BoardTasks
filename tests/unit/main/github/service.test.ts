import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainEvent } from '../../../../src/shared/events';

const events: MainEvent[] = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: (_c: string, e: MainEvent) => { events.push(e); } },
};

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [fakeWindow], getFocusedWindow: () => null },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));

import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { createTask, getTask } from '../../../../src/main/db/repositories/tasks';
import { getLink, upsertLink } from '../../../../src/main/db/repositories/github-links';
import { flushEmitter } from '../../../../src/main/ipc/emitter';
import { createGithubService, STALE_MS, type GithubService } from '../../../../src/main/github/service';
import { githubHooks, installGithubHooks } from '../../../../src/main/github/hooks';
import type { FetchFn } from '../../../../src/main/github/api';

const TOKEN = 'github_pat_11ABCDEFG0123456789';
const BASE = 'https://api.github.com';

interface Stub { status?: number; body?: unknown; headers?: Record<string, string> }

function router(routes: Record<string, Stub>): { fetch: FetchFn; calls: string[]; routes: Record<string, Stub> } {
  const calls: string[] = [];
  const fetch: FetchFn = (url) => {
    const path = url.slice(BASE.length);
    calls.push(path);
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    const stub = key === undefined ? undefined : routes[key];
    if (!stub) return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(stub.body ?? {}), { status: stub.status ?? 200, headers: { 'content-type': 'application/json', ...stub.headers } }));
  };
  return { fetch, calls, routes };
}

const ISSUE = {
  number: 12, title: 'Fix the flicker', state: 'open', updated_at: '2026-09-16T10:00:00Z',
  html_url: 'https://github.com/o/r/issues/12', user: { login: 'octocat', avatar_url: 'https://avatars/1' },
  labels: [{ name: 'bug', color: 'd73a4a' }],
};

const okRoutes = (): Record<string, Stub> => ({ '/user': { body: { login: 'octocat' } }, '/repos/o/r/issues/12': { body: ISSUE } });

function drainEvents(): MainEvent[] {
  flushEmitter();
  return events.splice(0, events.length);
}

let svc: GithubService;

beforeEach(() => {
  openDatabase(':memory:');
  events.length = 0;
  installGithubHooks({ linkUrl: () => Promise.resolve(null) });
});
afterEach(() => {
  svc.stop();
  svc.clearToken();
  closeDatabase();
});

function make(routes: Record<string, Stub>, opts: { token?: boolean; now?: () => number; isFocused?: () => boolean } = {}): { calls: string[] } {
  const r = router(routes);
  svc = createGithubService({ fetch: r.fetch, now: opts.now, isFocused: opts.isFocused ?? ((): boolean => false), tickMs: 0 });
  return r;
}

async function connect(): Promise<void> {
  await svc.setToken(TOKEN);
  await svc.drain();
  drainEvents();
}

describe('token lifecycle', () => {
  it('validates the token with /user before storing it', async () => {
    const r = make(okRoutes());
    const status = await svc.setToken(TOKEN);
    expect(r.calls).toContain('/user');
    expect(status).toMatchObject({ connected: true, login: 'octocat', tokenHint: '6789', scopes: [] });
  });

  it('rejects a token GitHub does not accept, and stores nothing', async () => {
    make({ '/user': { status: 401 } });
    await expect(svc.setToken(TOKEN)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'GitHub rejected this token' });
    expect(await svc.status()).toMatchObject({ connected: false, login: null });
  });

  it('surfaces an unreachable GitHub as a retryable network error', async () => {
    make({ '/user': { status: 500 } });
    await expect(svc.setToken(TOKEN)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('clearToken disconnects and marks existing links no_token', async () => {
    make(okRoutes());
    await connect();
    const task = createTask({ title: 'Ship it' });
    await svc.link(task.id, 'https://github.com/o/r/issues/12');
    await svc.drain();
    drainEvents();

    const status = svc.clearToken();
    expect(status.connected).toBe(false);
    expect(getLink(task.id)!.error).toBe('no_token');
    expect(drainEvents().some((e) => e.type === 'github:linkChanged')).toBe(true);
  });
});

describe('linking', () => {
  it('stores the reference immediately, then enriches and emits both events', async () => {
    make(okRoutes());
    await connect();
    const task = createTask({ title: 'Ship it' });

    const immediate = await svc.link(task.id, 'https://github.com/o/r/issues/12');
    expect(immediate).toMatchObject({ owner: 'o', repo: 'r', number: 12, title: null, error: null });
    const first = drainEvents();
    expect(first.find((e) => e.type === 'github:linkChanged')).toBeTruthy();

    await svc.drain();
    const after = drainEvents();
    const linkChanged = after.find((e) => e.type === 'github:linkChanged');
    expect(linkChanged && linkChanged.type === 'github:linkChanged' && linkChanged.link.title).toBe('Fix the flicker');
    const dataChanged = after.find((e) => e.type === 'data:changed');
    expect(dataChanged && dataChanged.type === 'data:changed' && dataChanged.reason).toBe('github');
    expect(dataChanged && dataChanged.type === 'data:changed' && dataChanged.tasks[0]?.github?.state).toBe('open');

    const stored = getLink(task.id)!;
    expect(stored).toMatchObject({ title: 'Fix the flicker', state: 'open', author: 'octocat', error: null });
    expect(stored.labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
    expect(stored.fetchedAt).not.toBeNull();
  });

  it('links without a token, records no_token, and skips the network', async () => {
    const r = make(okRoutes());
    const task = createTask({ title: 'Ship it' });
    const link = await svc.link(task.id, 'o/r#12');
    expect(link.error).toBe('no_token');
    expect(link.url).toBe('https://github.com/o/r/issues/12');
    await svc.drain();
    expect(r.calls).toEqual([]);
    expect(getTask(task.id)!.github!.number).toBe(12);
  });

  it('records a per-link error instead of throwing when enrichment fails', async () => {
    make({ '/user': { body: { login: 'octocat' } }, '/repos/o/r/issues/12': { status: 404 } });
    await connect();
    const task = createTask({ title: 'Ship it' });
    await svc.link(task.id, 'https://github.com/o/r/issues/12');
    await svc.drain();
    expect(getLink(task.id)!.error).toBe('not_found');
  });

  it('re-linking a task to a different item clears the old enrichment', async () => {
    make({ ...okRoutes(), '/repos/o/r/issues/99': { body: { ...ISSUE, number: 99, title: 'Another' } } });
    await connect();
    const task = createTask({ title: 'Ship it' });
    await svc.link(task.id, 'https://github.com/o/r/issues/12');
    await svc.drain();
    expect(getLink(task.id)!.title).toBe('Fix the flicker');

    const relinked = await svc.link(task.id, 'https://github.com/o/r/issues/99');
    expect(relinked.title).toBeNull();
    await svc.drain();
    expect(getLink(task.id)!.title).toBe('Another');
  });

  it('rejects a link that is not a GitHub issue or pull request', async () => {
    make(okRoutes());
    const task = createTask({ title: 'Ship it' });
    await expect(svc.link(task.id, 'https://github.com/o/r')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.link('nope', 'https://github.com/o/r/issues/12')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('unlink removes the row and pushes the task', async () => {
    make(okRoutes());
    const task = createTask({ title: 'Ship it' });
    await svc.link(task.id, 'o/r#12');
    drainEvents();
    svc.unlink(task.id);
    expect(getLink(task.id)).toBeNull();
    const ev = drainEvents().find((e) => e.type === 'data:changed');
    expect(ev && ev.type === 'data:changed' && ev.tasks[0]?.github).toBeNull();
  });
});

describe('refresh', () => {
  it('refreshes one task or all of them', async () => {
    make(okRoutes());
    await connect();
    const a = createTask({ title: 'a' });
    const b = createTask({ title: 'b' });
    await svc.link(a.id, 'o/r#12');
    await svc.link(b.id, 'o/r#12');
    await svc.drain();

    const one = await svc.refresh({ taskId: a.id });
    expect(one).toHaveLength(1);
    expect(one[0]!.title).toBe('Fix the flicker');
    expect(await svc.refresh({ all: true })).toHaveLength(2);
    expect(await svc.refresh({ taskId: 'missing' })).toEqual([]);
  });

  it('one failing link does not stop the others', async () => {
    make({ '/user': { body: { login: 'o' } }, '/repos/o/r/issues/12': { body: ISSUE } });
    await connect();
    const good = createTask({ title: 'good' });
    const bad = createTask({ title: 'bad' });
    await svc.link(good.id, 'o/r#12');
    await svc.link(bad.id, 'o/other#3');
    await svc.drain();

    const all = await svc.refresh({ all: true });
    expect(all).toHaveLength(2);
    expect(getLink(good.id)!.error).toBeNull();
    expect(getLink(bad.id)!.error).toBe('not_found');
  });

  it('skips the network while rate-limited, then resumes after the reset', async () => {
    const reset = Math.floor(Date.parse('2026-09-17T12:30:00.000Z') / 1000);
    let clock = Date.parse('2026-09-17T12:00:00.000Z');
    const routes: Record<string, Stub> = {
      '/user': { body: { login: 'octocat' } },
      '/repos/o/r/issues/12': { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } },
    };
    const r = make(routes, { now: () => clock });
    await connect();
    const task = createTask({ title: 'a' });
    await svc.link(task.id, 'o/r#12');
    await svc.drain();
    expect(getLink(task.id)!.error).toBe('rate_limited');

    const callsAfterFirst = r.calls.length;
    await svc.refresh({ all: true });
    expect(r.calls.length).toBe(callsAfterFirst); // no request while limited
    expect((await svc.status()).error).toBe('rate_limited');

    routes['/repos/o/r/issues/12'] = { body: ISSUE };
    clock = Date.parse('2026-09-17T12:31:00.000Z');
    await svc.refresh({ all: true });
    expect(r.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(getLink(task.id)!.error).toBeNull();
  });

  it('refresh without a token marks links no_token exactly once', async () => {
    const r = make(okRoutes());
    const task = createTask({ title: 'a' });
    upsertLink(task.id, { host: 'github.com', owner: 'o', repo: 'r', type: 'issue', number: 12, url: 'https://github.com/o/r/issues/12' }, { error: null });
    drainEvents();
    const first = await svc.refresh({ all: true });
    expect(first[0]!.error).toBe('no_token');
    expect(drainEvents().filter((e) => e.type === 'github:linkChanged')).toHaveLength(1);
    await svc.refresh({ all: true });
    expect(drainEvents().filter((e) => e.type === 'github:linkChanged')).toHaveLength(0);
    expect(r.calls).toEqual([]);
  });
});

describe('background sweep', () => {
  it('refreshes stale links on window focus and skips fresh ones', async () => {
    let clock = Date.parse('2026-09-17T12:00:00.000Z');
    const r = make(okRoutes(), { now: () => clock, isFocused: () => true });
    await connect();
    const stale = createTask({ title: 'stale' });
    const fresh = createTask({ title: 'fresh' });
    upsertLink(stale.id, { host: 'github.com', owner: 'o', repo: 'r', type: 'issue', number: 12, url: 'https://github.com/o/r/issues/12' }, { fetchedAt: new Date(clock - STALE_MS - 1000).toISOString() });
    upsertLink(fresh.id, { host: 'github.com', owner: 'o', repo: 'r', type: 'issue', number: 12, url: 'https://github.com/o/r/issues/12' }, { fetchedAt: new Date(clock - 1000).toISOString() });
    const before = r.calls.length;

    svc.onWindowFocus();
    await svc.drain();
    expect(r.calls.length).toBe(before + 1);
    expect(getLink(stale.id)!.title).toBe('Fix the flicker');
    expect(getLink(fresh.id)!.title).toBeNull();

    // A second focus inside the sweep window does not re-hit GitHub.
    clock += 60_000;
    svc.onWindowFocus();
    await svc.drain();
    expect(r.calls.length).toBe(before + 1);
  });

  it('does nothing without a token', async () => {
    const r = make(okRoutes(), { isFocused: () => true });
    const task = createTask({ title: 'a' });
    upsertLink(task.id, { host: 'github.com', owner: 'o', repo: 'r', type: 'issue', number: 12, url: 'https://github.com/o/r/issues/12' });
    svc.onWindowFocus();
    await svc.drain();
    expect(r.calls).toEqual([]);
  });
});

describe('search', () => {
  it('refuses without a token and reports why', async () => {
    make(okRoutes());
    await expect(svc.search('flicker', 10)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', opts: { details: { reason: 'no_token' } } });
  });

  it('returns mapped results', async () => {
    make({
      ...okRoutes(),
      '/search/issues': { body: { items: [{ number: 5, title: 'An issue', state: 'open', updated_at: '2026-09-16T00:00:00Z', html_url: 'https://github.com/o/r/issues/5', user: { login: 'ann' } }] } },
    });
    await connect();
    const results = await svc.search('flicker', 10);
    expect(results).toEqual([{ url: 'https://github.com/o/r/issues/5', owner: 'o', repo: 'r', type: 'issue', number: 5, title: 'An issue', state: 'open', author: 'ann', updatedAt: '2026-09-16T00:00:00Z' }]);
  });

  it('maps a rate-limited search to a retryable error', async () => {
    make({ ...okRoutes(), '/search/issues': { status: 403, headers: { 'x-ratelimit-remaining': '0' } } });
    await connect();
    await expect(svc.search('x', 10)).rejects.toMatchObject({ code: 'RATE_LIMITED', opts: { retryable: true } });
  });
});

describe('hooks', () => {
  it('task creation links through the installed hook', async () => {
    make(okRoutes());
    await connect();
    const { initGithubService, disposeGithubService } = await import('../../../../src/main/github/service');
    const r = router(okRoutes());
    const live = initGithubService({ fetch: r.fetch, isFocused: () => false, tickMs: 0 });
    try {
      const task = createTask({ title: 'Ship it', githubUrl: 'https://github.com/o/r/issues/12' });
      const linked = await githubHooks.linkUrl(task.id, 'https://github.com/o/r/issues/12');
      expect(linked?.github).toMatchObject({ owner: 'o', repo: 'r', number: 12 });
      await live.drain();
    } finally {
      live.stop();
      disposeGithubService();
    }
  });
});

describe('search by number', () => {
  it('resolves owner/repo#number directly instead of searching', async () => {
    const r = make({ ...okRoutes(), '/search/issues': { body: { items: [] } } });
    await connect();
    const results = await svc.search('o/r#12', 10);
    expect(results).toEqual([{ url: 'https://github.com/o/r/issues/12', owner: 'o', repo: 'r', type: 'issue', number: 12, title: 'Fix the flicker', state: 'open', author: 'octocat', updatedAt: '2026-09-16T10:00:00Z' }]);
    expect(r.calls.some((c) => c.startsWith('/search'))).toBe(false);
  });

  it('falls back to a search when that number does not exist', async () => {
    const r = make({ ...okRoutes(), '/search/issues': { body: { items: [] } } });
    await connect();
    expect(await svc.search('o/r#999', 10)).toEqual([]);
    expect(r.calls.some((c) => c.startsWith('/search'))).toBe(true);
  });
});
