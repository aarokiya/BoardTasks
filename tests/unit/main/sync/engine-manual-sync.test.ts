import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import type { AuthState } from '../../../../src/shared/models';
import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../../../src/main/db/repositories/lists';
import { listOutboxRows, updateOutbox } from '../../../../src/main/db/repositories/outbox';
import { createTask, getTaskRow } from '../../../../src/main/db/repositories/tasks';
import { createScheduler, type SyncTrigger } from '../../../../src/main/sync/scheduler';
import { createFakeClock } from '../../../fakes/fake-clock';
import { createSilentLogger } from '../../../fakes/fake-network';
import { createSyncHarness, type SyncHarness } from '../../../fakes/sync-harness';

/**
 * `syncNow()` must resolve when the sync the USER asked for has finished.
 *
 * A manual trigger arriving mid-cycle is deliberately folded into a follow-up
 * cycle rather than starting a second one. Resolving the caller when the
 * *current* (already stale) cycle ends reports a result that predates the
 * user's own click.
 */

let h: SyncHarness;

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
});
afterEach(() => {
  closeDatabase();
});

describe('scheduler.manual', () => {
  it('resolves after the cycle it requested, not the one already running', async () => {
    const clock = createFakeClock();
    const logger = createSilentLogger();
    const started: SyncTrigger[] = [];
    const finished: SyncTrigger[] = [];
    const gates = new Map<SyncTrigger, { open: Promise<void>; release: () => void }>();
    for (const t of ['startup', 'manual'] as const) {
      let release!: () => void;
      const open = new Promise<void>((r) => {
        release = r;
      });
      gates.set(t, { open, release });
    }

    const scheduler = createScheduler({
      clock,
      logger,
      runCycle: async ({ trigger }) => {
        started.push(trigger);
        await gates.get(trigger)?.open;
        finished.push(trigger);
      },
      isOnline: () => true,
      authState: (): AuthState => 'signed_in',
      isOnBattery: () => false,
      isFocused: () => true,
    });

    scheduler.start();
    await clock.flush();
    expect(started).toEqual(['startup']);

    let resolved = false;
    const manual = scheduler.manual(false).then(() => {
      resolved = true;
    });

    // The startup cycle finishes; the manual one it deferred is now running.
    gates.get('startup')!.release();
    await clock.flush();
    expect(started).toEqual(['startup', 'manual']);
    expect(finished).toEqual(['startup']);
    expect(resolved).toBe(false);

    gates.get('manual')!.release();
    await clock.flush();
    await manual;
    expect(finished).toEqual(['startup', 'manual']);
    scheduler.stop();
  });

  it('still resolves when stop() cuts the chain short', async () => {
    const clock = createFakeClock();
    const scheduler = createScheduler({
      clock,
      logger: createSilentLogger(),
      runCycle: () => Promise.resolve(),
      isOnline: () => true,
      authState: (): AuthState => 'signed_in',
      isOnBattery: () => false,
      isFocused: () => true,
    });
    scheduler.start();
    await clock.flush();
    const p = scheduler.manual(false);
    scheduler.stop();
    await expect(p).resolves.toBeUndefined();
  });
});

describe('engine.syncNow', () => {
  it('has pushed the edit made mid-cycle by the time it resolves', async () => {
    const listId = boundList();
    const engine = h.engine();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = h.google.listTaskLists.bind(h.google);
    let gated = false;
    h.pullDeps.api.listTaskLists = async (token?: string) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      return original(token);
    };

    engine.start();
    await h.clock.flush();

    // The user edits and hits ⌘R while the first cycle is parked on the network.
    const task = createTask({ title: 'Urgent', listId, previousId: 'end' });
    const manual = engine.syncNow();
    release();
    await manual;

    expect(getTaskRow(task.id)!.remote_id).not.toBeNull();
    engine.stop();
  });
});
