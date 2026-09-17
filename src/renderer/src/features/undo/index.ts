/**
 * Undo plumbing shared by every mutating command.
 *
 * The store owns the two stacks; this module owns the *shape* of an entry:
 * an apply/revert pair that can be replayed any number of times, so redo is
 * literally "apply again" rather than a second, subtly different code path.
 */
import { useStore } from '../../store/store';

export interface UndoableOp {
  /** Shown in the "Undid: …" toast. */
  label: string;
  apply: () => Promise<void>;
  revert: () => Promise<void>;
}

/** Run an operation and record it on the undo stack. */
export async function runUndoable(op: UndoableOp): Promise<void> {
  await op.apply();
  useStore.getState().pushUndo({ label: op.label, undo: op.revert, redo: op.apply });
}

/** Record an operation that has already been applied. */
export function recordUndoable(op: UndoableOp): void {
  useStore.getState().pushUndo({ label: op.label, undo: op.revert, redo: op.apply });
}

export const canUndo = (): boolean => useStore.getState().undoPast.length > 0;
export const canRedo = (): boolean => useStore.getState().undoFuture.length > 0;

/** Label of the entry ⌘Z would reverse, for menu items and tooltips. */
export const nextUndoLabel = (): string | null => useStore.getState().undoPast.at(-1)?.label ?? null;
export const nextRedoLabel = (): string | null => useStore.getState().undoFuture.at(-1)?.label ?? null;
