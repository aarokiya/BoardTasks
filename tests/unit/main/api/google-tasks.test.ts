import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_TASKS_BASE_URL } from '../../../../src/shared/constants';
import { createGoogleTasksApi, PAGE_SIZE, resolveBaseUrl } from '../../../../src/main/api/google-tasks';
import type { HttpClient, RequestSpec } from '../../../../src/main/api/http-client';
import { SchemaError } from '../../../../src/main/api/schemas';
import { createServerClock } from '../../../../src/main/api/server-clock';
import { createFakeClock } from '../../../fakes/fake-clock';

function recordingClient(responses: unknown[] = [{}]) {
  const specs: RequestSpec[] = [];
  let i = 0;
  const clock = createFakeClock();
  const http: HttpClient = {
    baseUrl: 'https://tasks.example/tasks/v1',
    serverClock: createServerClock(clock),
    request: (spec) => {
      specs.push(spec);
      const data = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve({ data, status: 200, etag: null, serverDate: 'Thu, 17 Sep 2026 12:00:00 GMT' } as never);
    },
  };
  return { http, specs, api: createGoogleTasksApi(http) };
}

describe('resolveBaseUrl', () => {
  const saved = process.env['BT_GOOGLE_BASE_URL'];
  beforeEach(() => {
    delete process.env['BT_GOOGLE_BASE_URL'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['BT_GOOGLE_BASE_URL'];
    else process.env['BT_GOOGLE_BASE_URL'] = saved;
  });

  it('uses the production constant by default', () => {
    expect(resolveBaseUrl()).toBe(GOOGLE_TASKS_BASE_URL);
  });

  it('appends /tasks/v1 to an override so the fake server serves the real path shape', () => {
    expect(resolveBaseUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/tasks/v1');
    expect(resolveBaseUrl('http://127.0.0.1:1234/')).toBe('http://127.0.0.1:1234/tasks/v1');
  });

  it('reads BT_GOOGLE_BASE_URL when no explicit override is given', () => {
    process.env['BT_GOOGLE_BASE_URL'] = 'http://localhost:9';
    expect(resolveBaseUrl()).toBe('http://localhost:9/tasks/v1');
  });
});

describe('listTasks request shape', () => {
  it('ALWAYS sends all four show* flags explicitly and maxResults=100', async () => {
    // Google's own docs contradict each other on the showHidden default, so
    // relying on any of them is a coin flip.
    const { api, specs } = recordingClient([{ items: [] }]);
    await api.listTasks({ tasklist: 'L1' });
    const q = specs[0]!.query!;
    expect(q['showCompleted']).toBe(true);
    expect(q['showHidden']).toBe(true);
    expect(q['showDeleted']).toBe(true);
    expect(q['showAssigned']).toBe(true);
    expect(q['maxResults']).toBe(PAGE_SIZE);
    expect(specs[0]!.path).toBe('/lists/L1/tasks');
    expect(specs[0]!.idempotent).toBe(true);
  });

  it('passes through updatedMin / pageToken / dueMin / dueMax and url-encodes the list id', async () => {
    const { api, specs } = recordingClient([{ items: [] }]);
    await api.listTasks({
      tasklist: 'a/b c',
      updatedMin: '2026-09-17T00:00:00.000Z',
      pageToken: 'tok',
      dueMin: '2026-01-01T00:00:00.000Z',
      dueMax: '2026-12-31T00:00:00.000Z',
      showCompleted: false,
    });
    expect(specs[0]!.path).toBe('/lists/a%2Fb%20c/tasks');
    expect(specs[0]!.query).toMatchObject({
      updatedMin: '2026-09-17T00:00:00.000Z',
      pageToken: 'tok',
      dueMin: '2026-01-01T00:00:00.000Z',
      dueMax: '2026-12-31T00:00:00.000Z',
      showCompleted: false,
    });
  });

  it('surfaces the server Date header with the page', async () => {
    const { api } = recordingClient([{ items: [{ id: 'T1' }], nextPageToken: 'n' }]);
    const page = await api.listTasks({ tasklist: 'L1' });
    expect(page.nextPageToken).toBe('n');
    expect(page.serverDate).toBe('Thu, 17 Sep 2026 12:00:00 GMT');
  });
});

describe('mutation request shapes', () => {
  it('insertTask sets parent/previous as QUERY params and is not idempotent', async () => {
    // parent and position are output-only: they cannot be set in a body.
    const { api, specs } = recordingClient([{ id: 'T9' }]);
    await api.insertTask('L1', { title: 'x', due: '2026-09-18T00:00:00.000Z' }, { parent: 'P1', previous: 'S1' });
    expect(specs[0]!.method).toBe('POST');
    expect(specs[0]!.path).toBe('/lists/L1/tasks');
    expect(specs[0]!.query).toEqual({ parent: 'P1', previous: 'S1' });
    expect(specs[0]!.body).toEqual({ title: 'x', due: '2026-09-18T00:00:00.000Z' });
    // A lost 500 might mean the task WAS created; the outbox owns the retry.
    expect(specs[0]!.idempotent).toBe(false);
  });

  it('patchTask sends If-Match only when an etag is supplied', async () => {
    const { api, specs } = recordingClient([{ id: 'T1' }, { id: 'T1' }]);
    await api.patchTask('L1', 'T1', { title: 'a' });
    await api.patchTask('L1', 'T1', { title: 'b' }, '"e1"');
    expect(specs[0]!.headers).toBeUndefined();
    expect(specs[1]!.headers).toEqual({ 'if-match': '"e1"' });
    expect(specs[1]!.idempotent).toBe(true);
  });

  it('moveTask sends parent/previous/destinationTasklist as query params', async () => {
    const { api, specs } = recordingClient([{ id: 'T1' }]);
    await api.moveTask('L1', 'T1', { parent: 'P', previous: 'S', destinationTasklist: 'L2' });
    expect(specs[0]!.path).toBe('/lists/L1/tasks/T1/move');
    expect(specs[0]!.query).toEqual({ parent: 'P', previous: 'S', destinationTasklist: 'L2' });
  });

  it('clearCompleted and deleteTask hit the right paths', async () => {
    const { api, specs } = recordingClient([undefined, undefined]);
    await api.clearCompleted('L1');
    await api.deleteTask('L1', 'T1');
    expect(specs[0]!.path).toBe('/lists/L1/clear');
    expect(specs[1]!.method).toBe('DELETE');
    expect(specs[1]!.path).toBe('/lists/L1/tasks/T1');
  });

  it('tasklist calls use the /users/@me/lists shape', async () => {
    const { api, specs } = recordingClient([{ items: [] }, { id: 'L9' }, { id: 'L9' }, undefined]);
    await api.listTaskLists();
    await api.insertTaskList({ title: 'New' });
    await api.patchTaskList('L9', { title: 'Renamed' });
    await api.deleteTaskList('L9');
    expect(specs.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /users/@me/lists',
      'POST /users/@me/lists',
      'PATCH /users/@me/lists/L9',
      'DELETE /users/@me/lists/L9',
    ]);
    expect(specs[1]!.idempotent).toBe(false);
  });
});

describe('response validation', () => {
  it('tolerates unknown fields (Google adds them without warning)', async () => {
    const { api } = recordingClient([{ items: [{ id: 'T1', title: 'a', somethingNew: 42 }], unexpectedTop: true }]);
    const page = await api.listTasks({ tasklist: 'L1' });
    expect(page.items[0]).toMatchObject({ id: 'T1', title: 'a', somethingNew: 42 });
  });

  it('rejects a response missing the one field we truly depend on', async () => {
    const { api } = recordingClient([{ items: [{ title: 'no id' }] }]);
    await expect(api.listTasks({ tasklist: 'L1' })).rejects.toBeInstanceOf(SchemaError);
  });

  it('treats an empty body as an empty page rather than crashing', async () => {
    const { api } = recordingClient([undefined]);
    const page = await api.listTaskLists();
    expect(page.items).toEqual([]);
    expect(page.nextPageToken).toBeNull();
  });
});
