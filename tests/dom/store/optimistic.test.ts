import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Task } from '@shared/models';
import { useStore } from '@/store/store';
import { installMockApi, makeTask, type MockApi } from '../../setup/mockApi';

/**
 * Optimistic patch → response install → push event.
 *
 * `installTasks` drops anything with `rev < current`. The optimistic patch has
 * to advance the revision too, otherwise a `data:changed` carrying the
 * PRE-EDIT row (rev == the local one) is not "older" and silently reverts what
 * the user just typed.
 */

let api: MockApi;

function reset(tasks: Partial<Task>[]): void {
  useStore.setState({
    tasks: {}, lists: {}, version: 0, selection: [], focusId: null, anchorId: null,
    undoPast: [], undoFuture: [], toasts: [], bufferedEvents: [], dragging: false,
  });
  api = installMockApi({ tasks });
}

beforeEach(() => {
  reset([]);
});
afterEach(() => {
  useStore.setState({ tasks: {}, lists: {}, version: 0 });
});

describe('store optimistic updates', () => {
  it('ignores a data:changed that predates the local edit', async () => {
    const seed = makeTask({ title: 'Original', rev: 4 });
    api.state.tasks.set(seed.id, seed);
    useStore.setState({ tasks: { [seed.id]: seed }, version: 1 });

    // The user types. The response is not back yet.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    api.stub('tasks:update', async (p) => {
      await gate;
      const cur = api.state.tasks.get(p.id)!;
      const next = { ...cur, ...p.patch, rev: cur.rev + 1 };
      api.state.tasks.set(next.id, next);
      return next;
    });

    const pending = useStore.getState().updateTask(seed.id, { title: 'Edited' });
    expect(useStore.getState().tasks[seed.id]!.title).toBe('Edited');

    // A push event carrying the row as it was BEFORE the edit arrives first.
    useStore.getState().applyEvent({
      type: 'data:changed', reason: 'sync', tasks: [seed], lists: [], deletedTaskIds: [], deletedListIds: [],
    });
    expect(useStore.getState().tasks[seed.id]!.title).toBe('Edited');

    release();
    await pending;
    expect(useStore.getState().tasks[seed.id]!.title).toBe('Edited');
    expect(useStore.getState().tasks[seed.id]!.rev).toBe(5);
  });

  it('rolls the optimistic patch back when the mutation fails', async () => {
    const seed = makeTask({ title: 'Original', rev: 4 });
    api.state.tasks.set(seed.id, seed);
    useStore.setState({ tasks: { [seed.id]: seed }, version: 1 });

    api.failNext('tasks:update');
    await expect(useStore.getState().updateTask(seed.id, { title: 'Edited' })).rejects.toThrow();

    // main never wrote, so the re-read is BEHIND the optimistic revision — and
    // is still the truth.
    expect(useStore.getState().tasks[seed.id]!.title).toBe('Original');
    expect(useStore.getState().tasks[seed.id]!.rev).toBe(4);
  });

  it('rolls a failed bulk setStatus back', async () => {
    const a = makeTask({ title: 'A', rev: 3 });
    api.state.tasks.set(a.id, a);
    useStore.setState({ tasks: { [a.id]: a }, version: 1 });

    api.failNext('tasks:setStatus');
    await expect(useStore.getState().setStatus([a.id], true)).rejects.toThrow();
    expect(useStore.getState().tasks[a.id]!.status).toBe('needsAction');
  });

  it('still accepts a genuinely newer server revision', () => {
    const seed = makeTask({ title: 'Original', rev: 4 });
    useStore.setState({ tasks: { [seed.id]: seed }, version: 1 });

    useStore.getState().applyEvent({
      type: 'data:changed', reason: 'sync',
      tasks: [{ ...seed, title: 'From another device', rev: 9 }],
      lists: [], deletedTaskIds: [], deletedListIds: [],
    });
    expect(useStore.getState().tasks[seed.id]!.title).toBe('From another device');
  });

  it('bulk setStatus advances every revision so mixed parent/child edits stick', async () => {
    const parent = makeTask({ title: 'Parent', rev: 2 });
    const child = makeTask({ title: 'Child', parentId: parent.id, rev: 7 });
    api.state.tasks.set(parent.id, parent);
    api.state.tasks.set(child.id, child);
    useStore.setState({ tasks: { [parent.id]: parent, [child.id]: child }, version: 1 });

    const done = useStore.getState().setStatus([parent.id, child.id], true);
    expect(useStore.getState().tasks[parent.id]!.status).toBe('completed');
    expect(useStore.getState().tasks[child.id]!.status).toBe('completed');

    // A stale event for both rows must not un-complete them.
    useStore.getState().applyEvent({
      type: 'data:changed', reason: 'sync', tasks: [parent, child], lists: [], deletedTaskIds: [], deletedListIds: [],
    });
    expect(useStore.getState().tasks[parent.id]!.status).toBe('completed');
    expect(useStore.getState().tasks[child.id]!.status).toBe('completed');
    await done;
  });

  it('restores children along with the parent', async () => {
    const parent = makeTask({ title: 'Parent' });
    const child = makeTask({ title: 'Child', parentId: parent.id });
    api.state.tasks.set(parent.id, parent);
    api.state.tasks.set(child.id, child);
    useStore.setState({ tasks: { [parent.id]: parent, [child.id]: child }, version: 1 });

    await useStore.getState().deleteTasks([parent.id]);
    expect(useStore.getState().tasks[parent.id]).toBeUndefined();
    expect(useStore.getState().tasks[child.id]).toBeUndefined();

    // Main restores the subtree and returns every row it brought back.
    api.stub('tasks:restore', () => [parent, child]);
    await useStore.getState().restoreTasks([parent.id]);
    expect(useStore.getState().tasks[parent.id]).toBeDefined();
    expect(useStore.getState().tasks[child.id]).toBeDefined();
  });

  it('drops deleted ids from the selection', () => {
    const a = makeTask({});
    const b = makeTask({});
    useStore.setState({ tasks: { [a.id]: a, [b.id]: b }, selection: [a.id, b.id], focusId: b.id, version: 1 });

    useStore.getState().applyEvent({
      type: 'data:changed', reason: 'sync', tasks: [], lists: [], deletedTaskIds: [b.id], deletedListIds: [],
    });
    expect(useStore.getState().selection).toEqual([a.id]);
    expect(useStore.getState().focusId).toBe(a.id);
  });
});
