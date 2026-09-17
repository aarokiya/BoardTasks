import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGoogle, type FakeGoogleServer } from '../../../fixtures/fakeGoogle';

/**
 * The fake server is load-bearing for every E2E test, so it gets its own
 * tests. A fixture nobody checks is a fixture that silently drifts from the
 * behaviour it is supposed to imitate.
 */

let g: FakeGoogleServer;
const AUTH = { authorization: 'Bearer ya29.fake' };

beforeAll(async () => {
  g = await startFakeGoogle();
});
afterAll(async () => {
  await g.stop();
});
beforeEach(async () => {
  await api('/__control/reset', { method: 'POST', body: '{}' });
});

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${g.url}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...AUTH, ...(init.headers as Record<string, string> | undefined) },
  });
}
async function json<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await api(path, init);
  return (await res.json()) as T;
}
const T = '/tasks/v1';
const L = 'L-default';

interface TaskJson {
  id: string;
  title: string;
  status: string;
  due?: string;
  completed?: string | null;
  position: string;
  parent?: string;
  deleted?: boolean;
  hidden?: boolean;
  etag: string;
  updated: string;
}
interface Page {
  items?: TaskJson[];
  nextPageToken?: string;
}

async function addTask(title: string, query = ''): Promise<TaskJson> {
  return json<TaskJson>(`${T}/lists/${L}/tasks${query}`, { method: 'POST', body: JSON.stringify({ title }) });
}

describe('fake Google server: plumbing', () => {
  it('listens and seeds a default list', async () => {
    const page = await json<{ items: Array<{ id: string; title: string }> }>(`${T}/users/@me/lists`);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: L, title: 'My Tasks' });
  });

  it('sends a Date header on every response — the pull watermark depends on it', async () => {
    const res = await api(`${T}/users/@me/lists`);
    expect(res.headers.get('date')).toBeTruthy();
    expect(Number.isNaN(Date.parse(res.headers.get('date')!))).toBe(false);
  });

  it('rejects an unauthenticated API call with a Google-shaped 401', async () => {
    const res = await fetch(`${g.url}${T}/users/@me/lists`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: number; errors: Array<{ reason: string }> } };
    expect(body.error.code).toBe(401);
    expect(body.error.errors[0]!.reason).toBe('authError');
  });

  it('issues a token for any grant and accepts a revoke', async () => {
    const tok = await json<{ access_token: string; refresh_token: string; expires_in: number }>('/oauth/token', {
      method: 'POST',
      body: 'grant_type=authorization_code&code=xyz',
    });
    expect(tok.access_token).toMatch(/^ya29\./);
    expect(tok.expires_in).toBe(3600);
    expect((await api('/oauth/revoke', { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('answers an unknown route with a Google-shaped 404', async () => {
    const res = await api(`${T}/nope`);
    expect(res.status).toBe(404);
  });
});

describe('fake Google server: tasklists', () => {
  it('supports create, read, rename and delete', async () => {
    const created = await json<{ id: string; title: string }>(`${T}/users/@me/lists`, { method: 'POST', body: JSON.stringify({ title: 'Work' }) });
    expect(created.title).toBe('Work');

    const read = await json<{ title: string }>(`${T}/users/@me/lists/${created.id}`);
    expect(read.title).toBe('Work');

    const renamed = await json<{ title: string }>(`${T}/users/@me/lists/${created.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Work v2' }) });
    expect(renamed.title).toBe('Work v2');

    expect((await api(`${T}/users/@me/lists/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`${T}/users/@me/lists/${created.id}`)).status).toBe(404);
  });

  it('deleting a list takes its tasks with it', async () => {
    const list = await json<{ id: string }>(`${T}/users/@me/lists`, { method: 'POST', body: JSON.stringify({ title: 'Temp' }) });
    await json(`${T}/lists/${list.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: 'inside' }) });
    await api(`${T}/users/@me/lists/${list.id}`, { method: 'DELETE' });
    expect(g.state.tasks.filter((t) => t.listId === list.id)).toHaveLength(0);
  });
});

describe('fake Google server: task quirks', () => {
  it('truncates `due` to midnight UTC — the time component is discarded', async () => {
    const t = await json<TaskJson>(`${T}/lists/${L}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Dated', due: '2026-09-18T17:45:00.000Z' }),
    });
    expect(t.due).toBe('2026-09-18T00:00:00.000Z');
  });

  it('IGNORES parent and position in a request body', async () => {
    const parent = await addTask('Parent');
    const child = await json<TaskJson>(`${T}/lists/${L}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Child', parent: parent.id, position: '99999' }),
    });
    expect(child.parent).toBeUndefined();
    expect(child.position).not.toBe('99999');
  });

  it('sets hierarchy only through the ?parent= query param', async () => {
    const parent = await addTask('Parent');
    const child = await addTask('Child', `?parent=${parent.id}`);
    expect(child.parent).toBe(parent.id);
  });

  it('orders inserts with ?previous= and hands out opaque 20-digit positions', async () => {
    const a = await addTask('A');
    const b = await addTask('B', `?previous=${a.id}`);
    const c = await addTask('C', `?previous=${a.id}`);

    const page = await json<Page>(`${T}/lists/${L}/tasks?showDeleted=true&showHidden=true&maxResults=100`);
    expect(page.items!.map((t) => t.title)).toEqual(['A', 'C', 'B']);
    for (const t of page.items!) expect(t.position).toMatch(/^\d{20}$/);
    expect(a.position < c.position).toBe(true);
    expect(b.id).toBeTruthy();
  });

  it('renumbers positions on a move', async () => {
    const a = await addTask('A');
    const b = await addTask('B', `?previous=${a.id}`);
    const before = (await json<Page>(`${T}/lists/${L}/tasks?maxResults=100`)).items!.map((t) => t.position);

    await json(`${T}/lists/${L}/tasks/${b.id}/move`, { method: 'POST' }); // to the front
    const after = await json<Page>(`${T}/lists/${L}/tasks?maxResults=100`);
    expect(after.items!.map((t) => t.title)).toEqual(['B', 'A']);
    expect(after.items!.map((t) => t.position)).toEqual(before); // same slots, new occupants
  });

  it('moves a task to another list with ?destinationTasklist=', async () => {
    const other = await json<{ id: string }>(`${T}/users/@me/lists`, { method: 'POST', body: JSON.stringify({ title: 'Other' }) });
    const t = await addTask('Travelling');
    await json(`${T}/lists/${L}/tasks/${t.id}/move?destinationTasklist=${other.id}`, { method: 'POST' });

    expect((await json<Page>(`${T}/lists/${L}/tasks?maxResults=100`)).items ?? []).toHaveLength(0);
    expect((await json<Page>(`${T}/lists/${other.id}/tasks?maxResults=100`)).items!.map((x) => x.title)).toEqual(['Travelling']);
  });

  it('`clear` HIDES completed tasks; hidden is not deleted', async () => {
    const t = await addTask('Done thing');
    await json(`${T}/lists/${L}/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) });
    expect((await api(`${T}/lists/${L}/clear`, { method: 'POST' })).status).toBe(204);

    const server = g.state.tasks.find((x) => x.id === t.id)!;
    expect(server.hidden).toBe(true);
    expect(server.deleted).toBe(false);

    const visible = await json<Page>(`${T}/lists/${L}/tasks?showHidden=false&showDeleted=false&maxResults=100`);
    expect(visible.items ?? []).toHaveLength(0);
    const all = await json<Page>(`${T}/lists/${L}/tasks?showHidden=true&showDeleted=true&maxResults=100`);
    expect(all.items).toHaveLength(1);
  });

  it('`delete` leaves a tombstone rather than erasing the row', async () => {
    const t = await addTask('Doomed');
    expect((await api(`${T}/lists/${L}/tasks/${t.id}`, { method: 'DELETE' })).status).toBe(204);

    const withDeleted = await json<Page>(`${T}/lists/${L}/tasks?showDeleted=true&showHidden=true&maxResults=100`);
    expect(withDeleted.items![0]).toMatchObject({ id: t.id, deleted: true });

    const withoutDeleted = await json<Page>(`${T}/lists/${L}/tasks?showDeleted=false&maxResults=100`);
    expect(withoutDeleted.items ?? []).toHaveLength(0);
  });

  it('completing requires and returns a `completed` timestamp; reopening clears it', async () => {
    const t = await addTask('Toggle');
    const done = await json<TaskJson>(`${T}/lists/${L}/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) });
    expect(done.completed).toBeTruthy();
    const open = await json<TaskJson>(`${T}/lists/${L}/tasks/${t.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'needsAction', completed: null }),
    });
    expect(open.completed).toBeUndefined();
  });

  it('honours If-Match and answers 412 on a stale etag', async () => {
    const t = await addTask('Guarded');
    const ok = await api(`${T}/lists/${L}/tasks/${t.id}`, {
      method: 'PATCH',
      headers: { 'if-match': t.etag },
      body: JSON.stringify({ title: 'v2' }),
    });
    expect(ok.status).toBe(200);

    const stale = await api(`${T}/lists/${L}/tasks/${t.id}`, {
      method: 'PATCH',
      headers: { 'if-match': t.etag },
      body: JSON.stringify({ title: 'v3' }),
    });
    expect(stale.status).toBe(412);
  });
});

describe('fake Google server: filtering and paging', () => {
  it('pages with maxResults and pageToken', async () => {
    for (let i = 0; i < 25; i++) await addTask(`T${i}`);
    const first = await json<Page>(`${T}/lists/${L}/tasks?maxResults=10`);
    expect(first.items).toHaveLength(10);
    expect(first.nextPageToken).toBe('10');

    const second = await json<Page>(`${T}/lists/${L}/tasks?maxResults=10&pageToken=${first.nextPageToken!}`);
    expect(second.items).toHaveLength(10);

    const third = await json<Page>(`${T}/lists/${L}/tasks?maxResults=10&pageToken=${second.nextPageToken!}`);
    expect(third.items).toHaveLength(5);
    expect(third.nextPageToken).toBeUndefined();
  });

  it('filters by updatedMin', async () => {
    await addTask('Old');
    const cut = new Date(Date.now() + 5).toISOString();
    await new Promise((r) => setTimeout(r, 10));
    await addTask('New');

    const page = await json<Page>(`${T}/lists/${L}/tasks?maxResults=100&updatedMin=${encodeURIComponent(cut)}`);
    expect(page.items!.map((t) => t.title)).toEqual(['New']);
  });

  it('the tombstone toggle controls whether deletes flow with updatedMin', async () => {
    const t = await addTask('Vanishing');
    const cut = new Date(Date.now() - 1000).toISOString();
    await api(`${T}/lists/${L}/tasks/${t.id}`, { method: 'DELETE' });
    const q = `${T}/lists/${L}/tasks?maxResults=100&showDeleted=true&showHidden=true&updatedMin=${encodeURIComponent(cut)}`;

    expect((await json<Page>(q)).items!.some((x) => x.id === t.id)).toBe(true);

    await api('/__control/tombstones', { method: 'POST', body: JSON.stringify({ enabled: false }) });
    expect((await json<Page>(q)).items ?? []).toHaveLength(0);

    // ...but a FULL listing still shows it, which is what the reconcile uses.
    const full = await json<Page>(`${T}/lists/${L}/tasks?maxResults=100&showDeleted=true&showHidden=true`);
    expect(full.items!.some((x) => x.id === t.id)).toBe(true);
  });
});

describe('fake Google server: control endpoints', () => {
  it('offline destroys the connection — a real transport failure, not a 503', async () => {
    await api('/__control/offline', { method: 'POST', body: '{}' });
    await expect(api(`${T}/users/@me/lists`)).rejects.toThrow();
    await api('/__control/online', { method: 'POST', body: '{}' });
    expect((await api(`${T}/users/@me/lists`)).status).toBe(200);
  });

  it('fail-next scripts a finite number of failures', async () => {
    await api('/__control/fail-next', { method: 'POST', body: JSON.stringify({ method: 'GET', status: 500, times: 2 }) });
    expect((await api(`${T}/users/@me/lists`)).status).toBe(500);
    expect((await api(`${T}/users/@me/lists`)).status).toBe(500);
    expect((await api(`${T}/users/@me/lists`)).status).toBe(200);
  });

  it('fail-next can target a path prefix', async () => {
    await api('/__control/fail-next', { method: 'POST', body: JSON.stringify({ method: 'GET', path: `${T}/lists`, status: 503, times: 1 }) });
    expect((await api(`${T}/users/@me/lists`)).status).toBe(200);
    expect((await api(`${T}/lists/${L}/tasks`)).status).toBe(503);
  });

  it('rate-limit answers 429 with a Retry-After header', async () => {
    await api('/__control/rate-limit', { method: 'POST', body: JSON.stringify({ seconds: 30 }) });
    const res = await api(`${T}/users/@me/lists`);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: { errors: Array<{ reason: string }> } };
    expect(body.error.errors[0]!.reason).toBe('rateLimitExceeded');
    await api('/__control/rate-limit', { method: 'POST', body: JSON.stringify({ seconds: 0 }) });
  });

  it('mutate and delete simulate another device', async () => {
    const t = await addTask('Shared');
    await api('/__control/mutate', { method: 'POST', body: JSON.stringify({ taskId: t.id, patch: { title: 'Edited elsewhere', due: '2026-12-25' } }) });
    const after = await json<TaskJson>(`${T}/lists/${L}/tasks/${t.id}`);
    expect(after.title).toBe('Edited elsewhere');
    expect(after.due).toBe('2026-12-25T00:00:00.000Z');

    await api('/__control/delete', { method: 'POST', body: JSON.stringify({ taskId: t.id }) });
    expect(g.state.tasks.find((x) => x.id === t.id)!.deleted).toBe(true);
    expect((await api('/__control/mutate', { method: 'POST', body: JSON.stringify({ taskId: 'nope', patch: {} }) })).status).toBe(404);
  });

  it('skew moves the server clock relative to ours', async () => {
    await api('/__control/skew', { method: 'POST', body: JSON.stringify({ ms: -300_000 }) });
    const t = await addTask('Written on a slow server');
    expect(Date.parse(t.updated)).toBeLessThan(Date.now() - 200_000);
    await api('/__control/skew', { method: 'POST', body: JSON.stringify({ ms: 0 }) });
  });

  it('seed and state dump work, and reset restores the baseline', async () => {
    await api('/__control/seed', {
      method: 'POST',
      body: JSON.stringify({ lists: [{ id: 'L-work', title: 'Work' }], tasks: [{ list: 'L-work', title: 'Seeded' }] }),
    });
    const dump = await json<{ lists: Array<{ id: string }>; tasks: Array<{ title: string }>; requests: unknown[] }>('/__control/state');
    expect(dump.lists.map((l) => l.id)).toContain('L-work');
    expect(dump.tasks.map((t) => t.title)).toContain('Seeded');
    expect(dump.requests.length).toBeGreaterThan(0);

    await api('/__control/reset', { method: 'POST', body: '{}' });
    const after = await json<{ lists: Array<{ id: string }>; tasks: unknown[] }>('/__control/state');
    expect(after.lists.map((l) => l.id)).toEqual([L]);
    expect(after.tasks).toHaveLength(0);
  });

  it('the seed() helper works in-process too', async () => {
    g.seed({ lists: [{ id: 'L-p', title: 'Programmatic' }], tasks: [{ list: 'L-p', title: 'Direct' }] });
    const page = await json<Page>(`${T}/lists/L-p/tasks?maxResults=100`);
    expect(page.items!.map((t) => t.title)).toEqual(['Direct']);
  });
});
