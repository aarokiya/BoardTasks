import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import type { FetchLike, FetchResponseLike } from '../../../../src/main/api/http-client';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, getTaskRow } from '../../../../src/main/db/repositories/tasks';
import { createSyncEngine, type SyncEngine } from '../../../../src/main/sync/engine';
import { installSyncHooks } from '../../../../src/main/sync/hooks';
import { createNetworkMonitor, RECONNECT_STEPS_MS } from '../../../../src/main/sync/network-monitor';
import { createFakeRandom } from '../../../fakes/fake-clock';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * The whole point of the reconnect loop, end to end: edits made offline have to
 * reach Google shortly after the connection comes back, not at the next poll.
 *
 * This is the unit-level twin of tests/e2e/02-offline.spec.ts.
 */

const PROBE = 'https://tasks.example/tasks/v1';

let h: SyncHarness;
let engine: SyncEngine;
let partitioned = true;

/** A probe against the API origin: refused while partitioned, 404 once healed. */
const probeFetch: FetchLike = () =>
  partitioned
    ? Promise.reject(new Error('ECONNREFUSED'))
    : Promise.resolve<FetchResponseLike>({ status: 404, headers: { get: () => null }, text: () => Promise.resolve('') });

beforeEach(() => {
  openDatabase(':memory:');
  partitioned = true;
  h = createSyncHarness();
  installSyncHooks({ onLocalEdit: () => engine.localEdit(), onTasksChanged: () => {} });
});
afterEach(() => {
  engine.stop();
  closeDatabase();
  installSyncHooks({ onLocalEdit: () => {}, onTasksChanged: () => {} });
});

describe('coming back online', () => {
  it('drains the outbox within seconds of the connection returning', async () => {
    const list = createList({ title: 'Work' });
    const remote = h.google.lists()[0]!;
    bindListRemoteId(list.id, remote.id, remote.etag, remote.updated);
    for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });

    const network = createNetworkMonitor({
      clock: h.clock,
      fetch: probeFetch,
      logger: h.logger,
      random: createFakeRandom(0.5),
      platform: { isOnline: () => true, onPower: () => () => {} },
      probeUrl: PROBE,
      isUrgent: () => true,
    });

    engine = createSyncEngine({
      api: h.google,
      tokens: h.tokens,
      clock: h.clock,
      random: createFakeRandom(0.5),
      network,
      queue: h.queue,
      logger: h.logger,
      emit: (e) => h.events.push(e),
      // A long poll, so anything that drains here did so because of the
      // network-regain trigger and not because the timer happened to fire.
      intervals: { focusedMs: 10 * 60_000, backgroundMs: 10 * 60_000, batteryMs: 10 * 60_000 },
    });

    // The server is unreachable and three tasks are created offline.
    h.google.partition();
    engine.start();
    await h.clock.advance(1_000);

    const ids = ['Offline one', 'Offline two', 'Offline three'].map(
      (title) => createTask({ title, listId: list.id, previousId: 'end' }).id,
    );
    // One cycle attempt against the partitioned server is what drives the
    // monitor offline — real request outcomes, no hand-fed signals.
    engine.localEdit();
    await h.clock.advance(2_000);

    expect(network.status()).toBe('offline');
    expect(listOutboxRows(['pending', 'blocked']).length).toBeGreaterThan(0);
    for (const id of ids) expect(getTaskRow(id)!.remote_id).toBeNull();

    // The connection returns. Nothing else happens — no click, no edit, no
    // poll (the poll is ten minutes away). Only the reconnect ladder can
    // notice, and its first rung is 3s.
    h.google.heal();
    partitioned = false;

    await h.clock.advance(RECONNECT_STEPS_MS[0] + 500);

    expect(network.status()).toBe('online');
    for (const id of ids) expect(getTaskRow(id)!.remote_id, `"${getTaskRow(id)!.title}" never reached Google`).not.toBeNull();
    expect(listOutboxRows(['pending', 'blocked', 'parked'])).toHaveLength(0);
  });

  it('the regain triggers a cycle immediately rather than only re-arming the poll', async () => {
    const list = createList({ title: 'Work' });
    const remote = h.google.lists()[0]!;
    bindListRemoteId(list.id, remote.id, remote.etag, remote.updated);
    for (const row of listOutboxRows()) updateOutbox(row.id, { status: 'done' });

    engine = h.engine();
    engine.start();
    await h.clock.advance(1_000);

    // Force the engine's view of the network down without touching the outbox.
    h.network.set('offline');
    await h.clock.advance(1_000);

    const task = createTask({ title: 'Queued while offline', listId: list.id, previousId: 'end' });
    h.google.clearCalls();

    h.network.set('online');
    await h.clock.advance(1_000);

    expect(h.google.calls().some((c) => c.method === 'insertTask')).toBe(true);
    expect(getTaskRow(task.id)!.remote_id).not.toBeNull();
  });
});
