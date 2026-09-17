import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: () => {} },
}));

import { closeDatabase, openDatabase } from '../../../../src/main/db/connection';
import { createTask, getTask } from '../../../../src/main/db/repositories/tasks';
import { deleteLink, getLink, listAll, listStale, recordLinkError, upsertLink } from '../../../../src/main/db/repositories/github-links';
import { parseGithubUrl } from '../../../../src/main/github/url';

const REF = { ...parseGithubUrl('https://github.com/o/r/pull/7')!, url: 'https://github.com/o/r/pull/7' };

beforeEach(() => { openDatabase(':memory:'); });
afterEach(() => { closeDatabase(); });

describe('github links repository', () => {
  it('stores the reference immediately and hydrates it onto the task', () => {
    const task = createTask({ title: 'Ship it' });
    const link = upsertLink(task.id, REF);
    expect(link).toMatchObject({ taskId: task.id, owner: 'o', repo: 'r', type: 'pull', number: 7, title: null, state: null });
    expect(getTask(task.id)!.github).toMatchObject({ owner: 'o', repo: 'r', number: 7 });
  });

  it('every write bumps the task rev so the renderer refetches', () => {
    const task = createTask({ title: 'Ship it' });
    const rev0 = getTask(task.id)!.rev;
    upsertLink(task.id, REF);
    const rev1 = getTask(task.id)!.rev;
    expect(rev1).toBeGreaterThan(rev0);
    upsertLink(task.id, REF, { title: 'Fix it', state: 'open', fetchedAt: '2026-09-17T00:00:00.000Z' });
    const rev2 = getTask(task.id)!.rev;
    expect(rev2).toBeGreaterThan(rev1);
    recordLinkError(task.id, 'network');
    expect(getTask(task.id)!.rev).toBeGreaterThan(rev2);
    deleteLink(task.id);
    expect(getTask(task.id)!.rev).toBeGreaterThan(rev2 + 1);
  });

  it('upsert keeps one row per task and preserves id and createdAt', () => {
    const task = createTask({ title: 'Ship it' });
    const first = upsertLink(task.id, REF);
    const second = upsertLink(task.id, { ...REF, number: 9, url: 'https://github.com/o/r/pull/9' });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.number).toBe(9);
    expect(listAll()).toHaveLength(1);
  });

  it('omitted enrichment fields keep their previous value; explicit nulls clear them', () => {
    const task = createTask({ title: 'Ship it' });
    upsertLink(task.id, REF, { title: 'Fix the flicker', state: 'open', labels: [{ name: 'bug', color: 'd73a4a' }], author: 'octocat' });
    const afterError = recordLinkError(task.id, 'network')!;
    expect(afterError.title).toBe('Fix the flicker');
    expect(afterError.labels).toEqual([{ name: 'bug', color: 'd73a4a' }]);
    expect(afterError.error).toBe('network');

    const cleared = upsertLink(task.id, REF, { title: null, labels: [] });
    expect(cleared.title).toBeNull();
    expect(cleared.labels).toEqual([]);
    // Untouched fields survive.
    expect(cleared.author).toBe('octocat');
    expect(cleared.state).toBe('open');
  });

  it('listStale returns never-fetched links first, then the oldest', () => {
    const a = createTask({ title: 'a' });
    const b = createTask({ title: 'b' });
    const c = createTask({ title: 'c' });
    const now = Date.parse('2026-09-17T12:00:00.000Z');
    upsertLink(a.id, REF, { fetchedAt: null });
    upsertLink(b.id, { ...REF, number: 2 }, { fetchedAt: new Date(now - 60 * 60 * 1000).toISOString() });
    upsertLink(c.id, { ...REF, number: 3 }, { fetchedAt: new Date(now - 60 * 1000).toISOString() });
    const stale = listStale(30 * 60 * 1000, now);
    expect(stale.map((l) => l.taskId)).toEqual([a.id, b.id]);
  });

  it('deleting a task cascades to its link', () => {
    const task = createTask({ title: 'a' });
    upsertLink(task.id, REF);
    expect(deleteLink('no-such-task')).toBe(false);
    expect(deleteLink(task.id)).toBe(true);
    expect(getLink(task.id)).toBeNull();
    expect(listAll()).toEqual([]);
  });

  it('recordLinkError on a task with no link is a no-op', () => {
    expect(recordLinkError('missing', 'no_token')).toBeNull();
  });
});
