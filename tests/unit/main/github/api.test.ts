import { describe, expect, it, vi } from 'vitest';
import { buildSearchQuery, createGithubApi, GithubApiError, parseRepoAndNumber, rollupChecks, rollupReviews, type FetchFn } from '../../../../src/main/github/api';

const BASE = 'https://api.github.com';

interface Stub { status?: number; body?: unknown; headers?: Record<string, string>; fail?: Error }

function fakeFetch(routes: Record<string, Stub>): { fetch: FetchFn; calls: string[]; headers: Array<Record<string, string>> } {
  const calls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetch: FetchFn = (url, init) => {
    const path = url.slice(BASE.length);
    calls.push(path);
    headers.push({ ...(init?.headers as Record<string, string> | undefined) });
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    const stub = key === undefined ? undefined : routes[key];
    if (!stub) return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } }));
    if (stub.fail) return Promise.reject(stub.fail);
    return Promise.resolve(
      new Response(JSON.stringify(stub.body ?? {}), {
        status: stub.status ?? 200,
        headers: { 'content-type': 'application/json', ...stub.headers },
      }),
    );
  };
  return { fetch, calls, headers };
}

const api = (routes: Record<string, Stub>, token: string | null = 'github_pat_11ABCDEFG0123456789') => {
  const f = fakeFetch(routes);
  return { ...f, client: createGithubApi({ fetch: f.fetch, getToken: () => token }) };
};

describe('request plumbing', () => {
  it('sends the documented headers and bearer token', async () => {
    const { client, headers } = api({ '/user': { body: { login: 'octocat' } } });
    await client.viewer();
    expect(headers[0]).toMatchObject({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: 'Bearer github_pat_11ABCDEFG0123456789',
    });
  });

  it('fails with no_token before touching the network', async () => {
    const { client, calls } = api({ '/user': { body: {} } }, null);
    await expect(client.viewer()).rejects.toMatchObject({ kind: 'no_token' });
    expect(calls).toEqual([]);
  });

  it('captures rate-limit headers from every response', async () => {
    const reset = Math.floor(Date.UTC(2026, 8, 17, 12, 0, 0) / 1000);
    const { client } = api({ '/user': { body: { login: 'o' }, headers: { 'x-ratelimit-remaining': '4987', 'x-ratelimit-reset': String(reset) } } });
    await client.viewer();
    expect(client.rateLimit()).toEqual({ remaining: 4987, resetAt: '2026-09-17T12:00:00.000Z' });
  });

  it('reads scopes from X-OAuth-Scopes and tolerates fine-grained tokens omitting it', async () => {
    const classic = api({ '/user': { body: { login: 'a' }, headers: { 'x-oauth-scopes': 'repo, read:org' } } });
    await expect(classic.client.viewer()).resolves.toEqual({ login: 'a', scopes: ['repo', 'read:org'] });
    const fine = api({ '/user': { body: { login: 'b' } } });
    await expect(fine.client.viewer()).resolves.toEqual({ login: 'b', scopes: [] });
  });
});

describe('error mapping', () => {
  it('401 → unauthorized', async () => {
    const { client } = api({ '/user': { status: 401, body: { message: 'Bad credentials' } } });
    await expect(client.viewer()).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });

  it('403 with X-RateLimit-Remaining: 0 → rate_limited with a reset time', async () => {
    const reset = Math.floor(Date.UTC(2026, 8, 17, 13, 0, 0) / 1000);
    const { client } = api({ '/user': { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } } });
    const e = (await client.viewer().catch((x: unknown) => x)) as GithubApiError;
    expect(e).toBeInstanceOf(GithubApiError);
    expect(e.kind).toBe('rate_limited');
    expect(e.resetAt).toBe('2026-09-17T13:00:00.000Z');
  });

  it('403 with quota left → forbidden', async () => {
    const { client } = api({ '/user': { status: 403, headers: { 'x-ratelimit-remaining': '4000' } } });
    await expect(client.viewer()).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('429 with Retry-After → rate_limited', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T10:00:00.000Z'));
    const { client } = api({ '/user': { status: 429, headers: { 'retry-after': '60' } } });
    const e = (await client.viewer().catch((x: unknown) => x)) as GithubApiError;
    expect(e.kind).toBe('rate_limited');
    expect(e.resetAt).toBe('2026-09-17T10:01:00.000Z');
    vi.useRealTimers();
  });

  it('404 → not_found', async () => {
    const { client } = api({});
    await expect(client.getIssueOrPull('o', 'r', 1)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('a thrown fetch → network', async () => {
    const { client } = api({ '/user': { fail: new TypeError('fetch failed') } });
    await expect(client.viewer()).rejects.toMatchObject({ kind: 'network' });
  });

  it('a 500 → network', async () => {
    const { client } = api({ '/user': { status: 503 } });
    await expect(client.viewer()).rejects.toMatchObject({ kind: 'network' });
  });

  it('a timeout aborts and maps to network', async () => {
    const fetch: FetchFn = (_u, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
      });
    const client = createGithubApi({ fetch, getToken: () => 'github_pat_11ABCDEFG0123456789', timeoutMs: 5 });
    await expect(client.viewer()).rejects.toMatchObject({ kind: 'network', message: 'GitHub did not respond in time.' });
  });
});

describe('getIssueOrPull', () => {
  const issueBody = {
    number: 12, title: 'Fix the flicker', state: 'open', updated_at: '2026-09-16T10:00:00Z',
    html_url: 'https://github.com/o/r/issues/12', user: { login: 'octocat', avatar_url: 'https://avatars/1' },
    labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: '#0e8a16' }],
  };

  it('reads an issue without touching the pulls endpoints', async () => {
    const { client, calls } = api({ '/repos/o/r/issues/12': { body: issueBody } });
    const item = await client.getIssueOrPull('o', 'r', 12);
    expect(item).toMatchObject({
      type: 'issue', state: 'open', title: 'Fix the flicker', author: 'octocat',
      authorAvatarUrl: 'https://avatars/1', checks: null, reviewDecision: null,
    });
    expect(item.labels).toEqual([{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: '0e8a16' }]);
    expect(calls).toEqual(['/repos/o/r/issues/12']);
  });

  it('closed issues report closed', async () => {
    const { client } = api({ '/repos/o/r/issues/12': { body: { ...issueBody, state: 'closed' } } });
    expect((await client.getIssueOrPull('o', 'r', 12)).state).toBe('closed');
  });

  it('follows pull_request into checks and reviews', async () => {
    const { client, calls } = api({
      '/repos/o/r/issues/12': { body: { ...issueBody, pull_request: { merged_at: null }, html_url: 'https://github.com/o/r/pull/12' } },
      '/repos/o/r/pulls/12': { body: { state: 'open', merged: false, draft: false, mergeable: true, head: { sha: 'deadbeef' }, updated_at: '2026-09-17T09:00:00Z' } },
      '/repos/o/r/commits/deadbeef/check-runs': { body: { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] } },
      '/repos/o/r/pulls/12/reviews': { body: [{ user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'b' }, state: 'COMMENTED' }] },
    });
    const item = await client.getIssueOrPull('o', 'r', 12);
    expect(item).toMatchObject({ type: 'pull', state: 'open', checks: 'failure', reviewDecision: 'approved', mergeable: true, updatedAt: '2026-09-17T09:00:00Z' });
    expect(calls).toHaveLength(4);
  });

  it('reports merged and draft states', async () => {
    const merged = api({
      '/repos/o/r/issues/1': { body: { ...issueBody, number: 1, state: 'closed', pull_request: { merged_at: '2026-09-17T08:00:00Z' } } },
      '/repos/o/r/pulls/1': { body: { state: 'closed', merged: true, head: { sha: 'x' } } },
      '/repos/o/r/commits/x/check-runs': { body: { check_runs: [] } },
    });
    expect((await merged.client.getIssueOrPull('o', 'r', 1)).state).toBe('merged');
    // A merged PR does not waste a request on the reviews endpoint.
    expect(merged.calls.some((c) => c.includes('/reviews'))).toBe(false);

    const draft = api({
      '/repos/o/r/issues/2': { body: { ...issueBody, number: 2, pull_request: { merged_at: null } } },
      '/repos/o/r/pulls/2': { body: { state: 'open', merged: false, draft: true, head: { sha: 'y' } } },
      '/repos/o/r/commits/y/check-runs': { body: { check_runs: [] } },
      '/repos/o/r/pulls/2/reviews': { body: [] },
    });
    const d = await draft.client.getIssueOrPull('o', 'r', 2);
    expect(d.state).toBe('draft');
    expect(d.reviewDecision).toBe('review_required');
  });

  it('a failing checks sub-request leaves checks null instead of failing the refresh', async () => {
    const { client } = api({
      '/repos/o/r/issues/3': { body: { ...issueBody, number: 3, pull_request: { merged_at: null } } },
      '/repos/o/r/pulls/3': { body: { state: 'open', head: { sha: 'z' } } },
      '/repos/o/r/pulls/3/reviews': { body: [] },
    });
    const item = await client.getIssueOrPull('o', 'r', 3);
    expect(item.checks).toBeNull();
    expect(item.type).toBe('pull');
  });

  it('a 401 on a sub-request still propagates', async () => {
    const { client } = api({
      '/repos/o/r/issues/4': { body: { ...issueBody, number: 4, pull_request: { merged_at: null } } },
      '/repos/o/r/pulls/4': { body: { state: 'open', head: { sha: 'z' } } },
      '/repos/o/r/commits/z/check-runs': { status: 401 },
    });
    await expect(client.getIssueOrPull('o', 'r', 4)).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});

describe('rollupChecks', () => {
  it.each([
    [[], null],
    [[{ status: 'completed', conclusion: 'success' }], 'success'],
    [[{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }], 'pending'],
    [[{ status: 'queued' }, { status: 'completed', conclusion: 'failure' }], 'failure'],
    [[{ status: 'completed', conclusion: 'timed_out' }], 'failure'],
    [[{ status: 'completed', conclusion: 'neutral' }, { status: 'completed', conclusion: 'skipped' }], 'neutral'],
    [[{ status: 'completed', conclusion: 'skipped' }, { status: 'completed', conclusion: 'success' }], 'success'],
  ] as Array<[Array<{ status?: string; conclusion?: string | null }>, string | null]>)('rolls %j up to %s', (runs, expected) => {
    expect(rollupChecks(runs)).toBe(expected);
  });
});

describe('rollupReviews', () => {
  it('takes the latest review per reviewer', () => {
    expect(rollupReviews([{ user: { login: 'a' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'a' }, state: 'APPROVED' }])).toBe('approved');
    expect(rollupReviews([{ user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'a' }, state: 'CHANGES_REQUESTED' }])).toBe('changes_requested');
  });
  it('any outstanding changes_requested wins over another reviewer approval', () => {
    expect(rollupReviews([{ user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'b' }, state: 'CHANGES_REQUESTED' }])).toBe('changes_requested');
  });
  it('ignores comments and pending reviews', () => {
    expect(rollupReviews([{ user: { login: 'a' }, state: 'COMMENTED' }, { user: { login: 'b' }, state: 'PENDING' }])).toBe('review_required');
  });
  it('a dismissed approval no longer counts', () => {
    expect(rollupReviews([{ user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'a' }, state: 'DISMISSED' }])).toBe('review_required');
  });
  it('empty means review required', () => {
    expect(rollupReviews([])).toBe('review_required');
  });
});

describe('buildSearchQuery', () => {
  it.each([
    ['', 'is:open involves:@me'],
    ['flicker', 'is:open involves:@me flicker'],
    ['vercel/next.js flicker', 'repo:vercel/next.js is:open flicker'],
    ['assignee:@me flaky', 'is:open assignee:@me flaky'],
    ['is:closed merged thing', 'involves:@me is:closed merged thing'],
    ['repo:o/r 123', 'is:open repo:o/r 123'],
    ['1234', 'is:open involves:@me 1234'],
  ])('%s → %s', (raw, expected) => {
    expect(buildSearchQuery(raw)).toBe(expected);
  });
});

describe('search', () => {
  it('maps items, deriving owner/repo/type from html_url', async () => {
    const { client, calls } = api({
      '/search/issues': {
        body: {
          items: [
            { number: 5, title: 'An issue', state: 'open', updated_at: '2026-09-16T00:00:00Z', html_url: 'https://github.com/o/r/issues/5', user: { login: 'ann' } },
            { number: 6, title: 'A PR', state: 'open', draft: true, updated_at: '2026-09-15T00:00:00Z', html_url: 'https://github.com/o/r/pull/6', user: { login: 'bob' }, pull_request: { merged_at: null } },
            { number: 7, title: 'Merged', state: 'closed', updated_at: '2026-09-14T00:00:00Z', html_url: 'https://github.com/o/r/pull/7', user: { login: 'cat' }, pull_request: { merged_at: '2026-09-14T00:00:00Z' } },
            { number: 8, title: 'Broken', html_url: 'not-a-github-url' },
          ],
        },
      },
    });
    const results = await client.search('o/r flicker', 10);
    expect(results.map((r) => [r.number, r.type, r.state])).toEqual([[5, 'issue', 'open'], [6, 'pull', 'draft'], [7, 'pull', 'merged']]);
    expect(results[0]).toMatchObject({ owner: 'o', repo: 'r', author: 'ann', title: 'An issue' });
    expect(calls[0]).toContain(`q=${encodeURIComponent('repo:o/r is:open flicker')}`);
    expect(calls[0]).toContain('per_page=10');
  });

  it('clamps the page size', async () => {
    const { client, calls } = api({ '/search/issues': { body: { items: [] } } });
    await client.search('x', 999);
    expect(calls[0]).toContain('per_page=50');
  });
});

describe('parseRepoAndNumber', () => {
  it.each([
    ['o/r 123', { owner: 'o', repo: 'r', number: 123 }],
    ['o/r#123', { owner: 'o', repo: 'r', number: 123 }],
    ['vercel/next.js # 7', { owner: 'vercel', repo: 'next.js', number: 7 }],
  ] as Array<[string, { owner: string; repo: string; number: number }]>)('%s is a direct reference', (raw, expected) => {
    expect(parseRepoAndNumber(raw)).toEqual(expected);
  });
  it.each(['o/r', '123', 'flicker', 'o/r 0', 'repo:o/r 12'])('%s is not', (raw) => {
    expect(parseRepoAndNumber(raw)).toBeNull();
  });
});
