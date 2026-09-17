import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { ApiError, ConflictError, NetworkError, RateLimitError } from '../../../../src/main/api/errors';
import { AuthError } from '../../../../src/main/auth/types';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox, type OutboxRow } from '../../../../src/main/db/repositories/outbox';
import { createTask } from '../../../../src/main/db/repositories/tasks';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * Every failure has to reach the renderer as one of a closed set of codes: the
 * "Changes that didn't sync" sheet maps them to human sentences, and an ad-hoc
 * code like `http_400` is shown to a person as nothing at all.
 */

let h: SyncHarness;

function boundList(title = 'Work'): string {
  const list = createList({ title });
  const remote = h.google.lists()[0]!;
  bindListRemoteId(list.id, remote.id, remote.etag, remote.updated);
  for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
  return list.id;
}

/** Push one create that fails with `error`, and return its outbox row. */
async function pushFailing(error: unknown): Promise<OutboxRow> {
  const listId = boundList();
  createTask({ title: 'Doomed', listId, previousId: 'end' });
  h.google.failNext('insertTask', error, 1);
  await h.push();
  return listOutboxRows(['pending', 'blocked', 'parked'])[0]!;
}

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
});
afterEach(() => {
  closeDatabase();
});

describe('outbox error codes', () => {
  it('400 is VALIDATION', async () => {
    const row = await pushFailing(new ApiError(400, { message: 'Title too long' }, false));
    expect(row.last_error_code).toBe('VALIDATION');
    expect(row.last_error).toMatch(/Title too long/);
  });

  it('a real 403 is FORBIDDEN, not a dead sign-in', async () => {
    const row = await pushFailing(new AuthError('insufficient_scope'));
    expect(row.last_error_code).toBe('FORBIDDEN');
  });

  it('404 is NOT_FOUND', async () => {
    const row = await pushFailing(new ApiError(404, null, false));
    expect(row.last_error_code).toBe('NOT_FOUND');
  });

  it('429 and a throttling 403 are both RATE_LIMITED', async () => {
    expect((await pushFailing(new RateLimitError(1_000, false, 'rateLimitExceeded'))).last_error_code).toBe('RATE_LIMITED');
    closeDatabase();
    openDatabase(':memory:');
    h = createSyncHarness();
    expect((await pushFailing(new RateLimitError(600_000, true, 'dailyLimitExceeded', 403))).last_error_code).toBe('RATE_LIMITED');
  });

  it('a transport failure is NETWORK', async () => {
    const row = await pushFailing(new NetworkError(new Error('down'), false));
    expect(row.last_error_code).toBe('NETWORK');
  });

  it('a timeout is NETWORK too, with the detail in the sentence', async () => {
    const row = await pushFailing(new NetworkError(new Error('slow'), true));
    expect(row.last_error_code).toBe('NETWORK');
    expect(row.last_error).toMatch(/timed out/i);
  });

  it('a 412 is CONFLICT', async () => {
    const row = await pushFailing(new ConflictError('"stale"'));
    expect(row.last_error_code).toBe('CONFLICT');
  });

  it('a dead sign-in is AUTH, and the entry survives it', async () => {
    const row = await pushFailing(new AuthError('invalid_grant'));
    expect(row.last_error_code).toBe('AUTH');
    expect(row.status).toBe('pending');
  });

  it('a 500 is INTERNAL', async () => {
    const row = await pushFailing(new ApiError(500, null, true));
    expect(row.last_error_code).toBe('INTERNAL');
  });

  it('an unrecognised throw is INTERNAL rather than an empty code', async () => {
    const row = await pushFailing(new Error('something odd'));
    expect(row.last_error_code).toBe('INTERNAL');
  });

  it('an unmet dependency is DEPENDENCY_FAILED, blocked and then parked', async () => {
    const list = createList({ title: 'Unsynced' }); // never bound, never pushed
    createTask({ title: 'Orphan', listId: list.id, previousId: 'end' });
    for (const row of listOutboxRows(['pending'])) {
      if (row.op === 'list.create') updateOutbox(row.id, { status: 'parked' });
    }

    await h.push();
    const blocked = listOutboxRows(['blocked']).find((r) => r.op === 'task.create')!;
    expect(blocked.last_error_code).toBe('DEPENDENCY_FAILED');
    expect(blocked.attempts).toBe(0);

    await h.push();
    await h.push();
    const parked = listOutboxRows(['parked']).find((r) => r.op === 'task.create')!;
    expect(parked.last_error_code).toBe('DEPENDENCY_FAILED');
  });

  it('every code the push can write is one the sheet knows how to look up', async () => {
    const seen = new Set<string>();
    for (const error of [
      new ApiError(400, null, false),
      new ApiError(403, null, false),
      new ApiError(404, null, false),
      new ApiError(409, null, false),
      new ApiError(500, null, true),
      new RateLimitError(1_000, false, 'rateLimitExceeded'),
      new NetworkError(new Error('x'), false),
      new ConflictError(null),
      new AuthError('invalid_grant'),
      new AuthError('insufficient_scope'),
      new Error('opaque'),
    ]) {
      closeDatabase();
      openDatabase(':memory:');
      h = createSyncHarness();
      const row = await pushFailing(error);
      seen.add(row.last_error_code!);
    }
    const allowed = new Set(['VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'NETWORK', 'DEPENDENCY_FAILED', 'CONFLICT', 'AUTH', 'INTERNAL']);
    for (const code of seen) expect(allowed.has(code), `unexpected outbox code ${code}`).toBe(true);
  });
});
