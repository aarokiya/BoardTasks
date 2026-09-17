import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { RateLimitError } from '../../../../src/main/api/errors';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, getTaskRow } from '../../../../src/main/db/repositories/tasks';
import type { SyncEngine } from '../../../../src/main/sync/engine';
import { installSyncHooks } from '../../../../src/main/sync/hooks';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * A 429 with `Retry-After: 60` used to be absorbed by a `sleep()` inside the
 * HTTP client. The cycle stayed open for the whole minute, so the status pill
 * said "Syncing…", `retryAfterMs` was never computed, and the countdown the
 * user needs to understand what is happening never appeared.
 */

let h: SyncHarness;
let engine: SyncEngine;

function boundList(title = 'Work'): string {
  const list = createList({ title });
  const remote = h.google.lists()[0]!;
  bindListRemoteId(list.id, remote.id, remote.etag, remote.updated);
  for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });
  return list.id;
}

beforeEach(() => {
  openDatabase(':memory:');
  h = createSyncHarness();
  engine = h.engine();
  installSyncHooks({ onLocalEdit: () => {}, onTasksChanged: () => {} });
});
afterEach(() => {
  engine.stop();
  closeDatabase();
  installSyncHooks({ onLocalEdit: () => {}, onTasksChanged: () => {} });
});

describe('a burst rate limit', () => {
  it('surfaces rate_limited with a countdown instead of an endless "syncing"', async () => {
    const listId = boundList();
    createTask({ title: 'Throttled', listId, previousId: 'end' });
    h.google.failNext('insertTask', new RateLimitError(60_000, false, 'rateLimitExceeded'), 1);

    engine.start();
    await h.clock.advance(1_000);

    const state = engine.getState();
    expect(state.status).toBe('rate_limited');
    expect(state.retryAfterMs).toBeGreaterThan(55_000);
    expect(state.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('does not burn an attempt and keeps the change queued', async () => {
    const listId = boundList();
    const task = createTask({ title: 'Throttled', listId, previousId: 'end' });
    h.google.failNext('insertTask', new RateLimitError(60_000, false, 'rateLimitExceeded'), 1);

    engine.start();
    await h.clock.advance(1_000);

    const row = listOutboxRows(['pending'])[0]!;
    expect(row.attempts, 'throttling is not the entry’s fault').toBe(0);
    expect(row.last_error_code).toBe('RATE_LIMITED');
    expect(getTaskRow(task.id)!.remote_id).toBeNull();
    expect(listOutboxRows(['parked'])).toHaveLength(0);
  });

  it('skips the pull while throttled rather than collecting more 429s', async () => {
    const listId = boundList();
    createTask({ title: 'Throttled', listId, previousId: 'end' });
    h.google.failNext('insertTask', new RateLimitError(60_000, false, 'rateLimitExceeded'), 1);

    engine.start();
    await h.clock.advance(1_000);
    expect(h.google.calls().some((c) => c.method === 'listTasks')).toBe(false);
  });

  it('resumes by itself once the wait is over, and sends the change', async () => {
    const listId = boundList();
    const task = createTask({ title: 'Throttled', listId, previousId: 'end' });
    h.google.failNext('insertTask', new RateLimitError(60_000, false, 'rateLimitExceeded'), 1);

    engine.start();
    await h.clock.advance(1_000);
    expect(engine.getState().status).toBe('rate_limited');

    // The poll must not fire before the server said it could.
    await h.clock.advance(30_000);
    expect(getTaskRow(task.id)!.remote_id, 'polled before the Retry-After expired').toBeNull();

    await h.clock.advance(45_000);
    expect(getTaskRow(task.id)!.remote_id).not.toBeNull();
    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().retryAfterMs).toBeNull();
  });

  it('a manual sync runs a cycle but still honours the wait Google asked for', async () => {
    const listId = boundList();
    const task = createTask({ title: 'Throttled', listId, previousId: 'end' });
    h.google.failNext('insertTask', new RateLimitError(60_000, false, 'rateLimitExceeded'), 1);

    engine.start();
    await h.clock.advance(1_000);
    expect(engine.getState().status).toBe('rate_limited');

    const before = engine.getState().lastSyncStartedAt;
    h.google.clearCalls();
    await h.settle(engine.syncNow());

    // The poll floor does not gag the user: a cycle really ran.
    expect(engine.getState().lastSyncStartedAt).not.toBe(before);
    // But the throttled entry keeps its Retry-After — re-asking Google the
    // instant it told us to wait is how a burst limit becomes a long one.
    expect(getTaskRow(task.id)!.remote_id).toBeNull();
    expect(listOutboxRows(['pending'])[0]!.attempts).toBe(0);
    expect(h.google.calls().some((c) => c.method === 'insertTask')).toBe(false);
  });
});

describe('a daily quota', () => {
  it('waits a long time and says why', async () => {
    const listId = boundList();
    createTask({ title: 'Over quota', listId, previousId: 'end' });
    h.google.failNext('insertTask', new RateLimitError(3_600_000, true, 'dailyLimitExceeded', 403), 1);

    engine.start();
    await h.clock.advance(1_000);

    const state = engine.getState();
    expect(state.status).toBe('rate_limited');
    expect(state.retryAfterMs).toBeGreaterThan(30 * 60_000);
    expect(state.errorMessage).toMatch(/daily quota/i);
    expect(listOutboxRows(['pending'])[0]!.attempts).toBe(0);
  });
});
