import type { ReactElement } from 'react';
/**
 * Owned by the Interactions track. The inline "new task" row shown at the top
 * of a list on ⌘N; shares the NL parser with the floating Quick Add window.
 */
export interface InlineQuickAddProps {
  listId: string | null;
  parentId?: string | null;
  onDone: () => void;
  autoFocus?: boolean;
}
export function InlineQuickAdd(_props: InlineQuickAddProps): ReactElement | null {
  return null;
}
