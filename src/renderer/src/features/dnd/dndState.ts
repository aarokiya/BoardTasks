import { createContext, useContext } from 'react';
import type { Projection } from './projection';

export interface TaskDndState {
  /** Task currently being dragged, or null. */
  activeTaskId: string | null;
  /** Live tree projection for the drop indicator. */
  projection: Projection | null;
  /** Row id the indicator is drawn above, or null. */
  indicatorRowId: string | null;
  /** Sidebar list currently hovered as a drop target. */
  overListId: string | null;
}

export const EMPTY_DND_STATE: TaskDndState = {
  activeTaskId: null,
  projection: null,
  indicatorRowId: null,
  overListId: null,
};

export const TaskDndContext = createContext<TaskDndState>(EMPTY_DND_STATE);

export function useTaskDnd(): TaskDndState {
  return useContext(TaskDndContext);
}
