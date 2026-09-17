import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { createGoogleTasksApi } from '../../../../src/main/api/google-tasks';
import { createHttpClient, type FetchLike } from '../../../../src/main/api/http-client';
import { AuthError } from '../../../../src/main/auth/types';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, getTaskRow, updateTask } from '../../../../src/main/db/repositories/tasks';
import { createSyncEngine } from '../../../../src/main/sync/engine';
import { installSyncHooks } from '../../../../src/main/sync/hooks';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * A refresh token that Google has revoked.
 *
 * The real path runs through the HTTP client: a 401 triggers exactly one
 * `forceRefresh`, that refresh dies with `invalid_grant`, and the client
 * reports the dead grant to the token provider — once, and never for a plain
 * 401-after-refresh. The engine must then pause with the outbox untouched:
 * unsynced changes surviving a re-auth is the whole point of local-first.
 *
 * BT_FAKE_AUTH never refreshes, so this is unreachable in E2E; it is pinned
 * here instead.
 */

let h: SyncHarness;

function unauthorizedFetch(): FetchLike {
  return () =>
    Promise.resolve({
      status: 401,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } })),
    });
}

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
  installSyncHooks({ onLocalEdit: () => {}, onTasksChanged: () => {} });
});
afterEach(() => {
  closeDatabase();
  installSyncHooks({ onLocalEdit: () => {}, onTasksChanged: () => {} });
});

describe('a revoked grant', () => {
  it('reports invalid_grant exactly once, pauses the engine, and keeps the outbox', async () => {
    const list = createList({ title: 'Work' });
    bindListRemoteId(list.id, 'L-default', '"l"', h.google.serverNowIso());
    for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
    const task = createTask({ title: 'Unsynced work', listId: list.id, previousId: 'end' });
    updateTask({ id: task.id, patch: { notes: 'still mine' } });
    const queuedBefore = listOutboxRows(['pending', 'blocked']).length;
    expect(queuedBefore).toBeGreaterThan(0);

    const http = createHttpClient({
      baseUrl: 'https://tasks.example/tasks/v1',
      fetch: unauthorizedFetch(),
      tokens: h.tokens,
      clock: h.clock,
      random: { next: () => 0.5 },
      logger: h.logger,
    });
    // The 401 provokes one forceRefresh; that refresh is the thing Google kills.
    h.tokens.failNextRefresh(new AuthError('invalid_grant'), 10);

    const engine = createSyncEngine({
      api: createGoogleTasksApi(http),
      tokens: h.tokens,
      clock: h.clock,
      random: { next: () => 0.5 },
      network: h.network,
      queue: h.queue,
      logger: h.logger,
      emit: (e) => h.events.push(e),
    });

    engine.start();
    await h.settle(Promise.resolve());

    expect(h.tokens.calls.invalidGrant).toBe(1);
    expect(h.tokens.getStatus().state).toBe('reauth_required');
    expect(engine.getState().status).toBe('reauth_required');

    // Nothing was dropped, nothing was parked, and the row still holds the edit.
    expect(listOutboxRows(['pending', 'blocked']).length).toBe(queuedBefore);
    expect(listOutboxRows(['parked'])).toHaveLength(0);
    expect(getTaskRow(task.id)!.notes).toBe('still mine');

    // While paused, further triggers must not hammer a dead grant.
    await engine.syncNow();
    expect(h.tokens.calls.invalidGrant).toBe(1);

    engine.stop();
  });

  it('resumes and drains the outbox once the user signs in again', async () => {
    const list = createList({ title: 'Work' });
    bindListRemoteId(list.id, h.google.lists()[0]!.id, '"l"', h.google.serverNowIso());
    for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
    const task = createTask({ title: 'Survives re-auth', listId: list.id, previousId: 'end' });

    const engine = h.engine();
    h.tokens.setState('reauth_required', 'invalid_grant');
    engine.start();
    await h.settle(Promise.resolve());
    expect(getTaskRow(task.id)!.remote_id).toBeNull();
    expect(listOutboxRows(['pending', 'blocked']).length).toBeGreaterThan(0);

    h.tokens.setState('signed_in');
    await h.settle(Promise.resolve());

    expect(getTaskRow(task.id)!.remote_id).not.toBeNull();
    expect(engine.getState().status).not.toBe('reauth_required');
    engine.stop();
  });
});
