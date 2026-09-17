import { describe, expect, it } from 'vitest';
import { PREVIOUS_END } from '@shared/models';
import { previousAt, projectDrop, type FlatItem } from '../../src/renderer/src/features/dnd/projection';

const flat = (spec: Array<[string, 0 | 1, boolean?]>): FlatItem[] =>
  spec.map(([id, depth, hasChildren]) => ({ id, depth, hasChildren: hasChildren ?? false }));

describe('tree projection', () => {
  const items = flat([['a', 0, true], ['a1', 1], ['a2', 1], ['b', 0], ['c', 0]]);

  it('keeps depth 0 when dragged flat onto another top-level row', () => {
    const p = projectDrop(items, 'c', 'b', 0);
    expect(p).not.toBeNull();
    expect(p!.depth).toBe(0);
    expect(p!.parentId).toBeNull();
  });

  it('indents to depth 1 under the row above when dragged right', () => {
    const p = projectDrop(items, 'c', 'b', 30);
    expect(p!.depth).toBe(1);
    expect(p!.parentId).toBe('a');
  });

  it('never projects deeper than one level', () => {
    const p = projectDrop(items, 'c', 'b', 300);
    expect(p!.depth).toBe(1);
  });

  it('forces depth 0 for a node that has children', () => {
    const p = projectDrop(items, 'a', 'c', 400);
    expect(p!.depth).toBe(0);
    expect(p!.parentId).toBeNull();
  });

  it('returns null when the ids are not in the list', () => {
    expect(projectDrop(items, 'zz', 'b', 0)).toBeNull();
    expect(projectDrop(items, 'a', 'zz', 0)).toBeNull();
  });

  it('previousAt finds the sibling above at the same depth', () => {
    const moved = flat([['a', 0], ['a1', 1], ['x', 1], ['a2', 1], ['b', 0]]);
    expect(previousAt(moved, 2, 1)).toBe('a1');
  });

  it('previousAt returns null for the first child of a parent', () => {
    const moved = flat([['a', 0], ['x', 1], ['a1', 1], ['b', 0]]);
    expect(previousAt(moved, 1, 1)).toBeNull();
  });

  it("previousAt returns 'end' when the drop is past the last row", () => {
    const moved = flat([['a', 0], ['b', 0], ['x', 0]]);
    expect(previousAt(moved, 2, 0)).toBe(PREVIOUS_END);
  });

  it('previousAt skips subtasks when placing a top-level row', () => {
    const moved = flat([['a', 0], ['a1', 1], ['x', 0], ['b', 0]]);
    expect(previousAt(moved, 2, 0)).toBe('a');
  });
});
