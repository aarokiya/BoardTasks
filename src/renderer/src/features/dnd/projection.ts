import { arrayMove } from '@dnd-kit/sortable';
import { PREVIOUS_END, type PreviousId } from '@shared/models';

export interface FlatItem {
  id: string;
  depth: 0 | 1;
  hasChildren: boolean;
}

export interface Projection {
  depth: 0 | 1;
  parentId: string | null;
  previousId: PreviousId;
  /** Index in the post-move ordering; the drop indicator is drawn above it. */
  overIndex: number;
}

export const INDENT_WIDTH = 24;

/**
 * Tree projection for a sortable drag. Depth is clamped to [0, 1] (Google
 * Tasks only renders one level) and forced to 0 when the dragged node has
 * children, because a subtask cannot itself have subtasks.
 */
export function projectDrop(
  items: FlatItem[],
  activeId: string,
  overId: string,
  dragOffsetX: number,
  indentWidth: number = INDENT_WIDTH,
): Projection | null {
  const activeIndex = items.findIndex((i) => i.id === activeId);
  const overIndex = items.findIndex((i) => i.id === overId);
  const active = items[activeIndex];
  if (activeIndex < 0 || overIndex < 0 || !active) return null;

  const moved = arrayMove(items, activeIndex, overIndex);
  const previous = moved[overIndex - 1];
  const next = moved[overIndex + 1];

  const dragDepth = Math.round(dragOffsetX / indentWidth);
  const projected = active.depth + dragDepth;
  const maxDepth = previous ? Math.min(1, previous.depth + 1) : 0;
  const minDepth = next ? next.depth : 0;

  let depth = Math.max(Math.min(projected, maxDepth), minDepth);
  if (active.hasChildren) depth = 0;
  if (depth !== 0 && depth !== 1) depth = depth > 1 ? 1 : 0;
  const finalDepth: 0 | 1 = depth === 1 ? 1 : 0;

  let parentId: string | null = null;
  if (finalDepth === 1) {
    for (let i = overIndex - 1; i >= 0; i--) {
      const it = moved[i];
      if (it && it.depth === 0) {
        parentId = it.id;
        break;
      }
    }
    // A depth-1 drop with no parent above it degrades to a top-level move.
    if (parentId === null) return { depth: 0, parentId: null, previousId: previousAt(moved, overIndex, 0), overIndex };
  }

  return { depth: finalDepth, parentId, previousId: previousAt(moved, overIndex, finalDepth), overIndex };
}

/** The sibling immediately above the drop point at `depth`. */
export function previousAt(moved: FlatItem[], overIndex: number, depth: 0 | 1): PreviousId {
  if (overIndex >= moved.length - 1) return PREVIOUS_END;
  for (let i = overIndex - 1; i >= 0; i--) {
    const it = moved[i];
    if (!it) continue;
    if (it.depth === depth) return it.id;
    if (it.depth < depth) return null;
  }
  return null;
}
