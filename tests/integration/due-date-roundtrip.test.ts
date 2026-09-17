import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { addDays, civilFromGoogleDue, googleDueFromCivil, todayCivil, type CivilDate } from '../../src/shared/date/civil';
import { formatMonthDay, formatRelative } from '../../src/shared/date/format';
import { closeDatabase, openDatabase } from '../../src/main/db/connection';
import { bindListRemoteId, createList } from '../../src/main/db/repositories/lists';
import { listOutboxRows, payloadOf, updateOutbox } from '../../src/main/db/repositories/outbox';
import { createTask, getAllTasks, getTaskRow } from '../../src/main/db/repositories/tasks';
import { createSyncHarness, type SyncHarness } from '../fakes/sync-harness';

/**
 * The end-to-end civil-date trace: Quick Add → repository → outbox payload →
 * the wire → the fake server (which truncates to midnight UTC) → pull → row.
 *
 * Run under `TZ=Pacific/Kiritimati` (UTC+14) and `TZ=America/Los_Angeles`
 * (UTC-8): those are the two zones where treating a `due` string as an instant
 * lands on the wrong calendar day in opposite directions.
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

describe(`civil dates end to end (TZ=${process.env['TZ'] ?? 'system'})`, () => {
  it('keeps the same calendar day from Quick Add through Google and back', async () => {
    const today = todayCivil();
    const tomorrow = addDays(today, 1);
    const listId = boundList();

    // 1. Quick Add turns "Pay rent tomorrow" into this civil date; the parser
    //    end of the trace is pinned in tests/unit/renderer/quickadd/quickadd-civil.test.ts,
    //    which cannot be imported here (renderer sources are out of this project).
    // 2. Repository stores the civil string verbatim.
    const task = createTask({ title: 'Pay rent', listId, due: tomorrow });
    expect(getTaskRow(task.id)!.due).toBe(tomorrow);

    // 3. The outbox payload carries the civil string, not an instant.
    const create = listOutboxRows(['pending']).find((r) => r.op === 'task.create')!;
    const payload = payloadOf(create);
    expect(payload.kind).toBe('task.create');
    if (payload.kind === 'task.create') expect(payload.fields.due).toBe(tomorrow);

    // 4. On the wire it is midnight UTC of that same calendar day.
    await h.push();
    const remoteId = getTaskRow(task.id)!.remote_id!;
    expect(h.google.task(remoteId)!.due).toBe(googleDueFromCivil(tomorrow));
    expect(h.google.task(remoteId)!.due).toBe(`${tomorrow}T00:00:00.000Z`);

    // 5. Pulling it back yields the same civil date, and the same row label.
    await h.pull({ full: true });
    expect(getTaskRow(task.id)!.due).toBe(tomorrow);
    expect(civilFromGoogleDue(h.google.task(remoteId)!.due)).toBe(tomorrow);
    expect(formatRelative(getTaskRow(task.id)!.due as CivilDate, today)).toBe('Tomorrow');
  });

  it('adopts a remote-only task onto the right calendar day', async () => {
    const listId = boundList();
    const remoteList = h.google.lists()[0]!;
    // Google always hands back midnight UTC, whatever was written.
    h.google.remoteInsert(remoteList.id, { title: 'Dentist', due: '2026-03-08T00:00:00.000Z' });

    await h.pull({ full: true });
    const row = getAllTasks().find((t) => t.title === 'Dentist')!;
    expect(row.due).toBe('2026-03-08');
    expect(row.listId).toBe(listId);
    // The label must read "Mar 8" in every zone, never Mar 7 or Mar 9.
    expect(formatMonthDay(row.due!)).toBe('Mar 8');
  });
});
