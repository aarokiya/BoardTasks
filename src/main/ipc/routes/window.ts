import { z } from 'zod';
import type { Routes } from '../router';
import { idSchema, taskCreateSchema, voidSchema } from '../schemas';
import { createTask } from '../../db/repositories/tasks';
import { emit, emitDataChanged } from '../emitter';
import { syncHooks } from '../../sync/hooks';
import { showMainWindow } from '../../windows/main-window';
import { hideQuickAdd, resizeQuickAdd, MAX_HEIGHT, MIN_HEIGHT } from '../../windows/quick-add-window';

type WindowRoutes = Pick<Routes, 'window:quickAddSubmit' | 'window:hideQuickAdd' | 'window:showMain' | 'window:resizeQuickAdd'>;

export function windowRoutes(): WindowRoutes {
  return {
    'window:quickAddSubmit': {
      schema: taskCreateSchema.extend({ keepOpen: z.boolean().optional() }),
      handle: (p) => {
        const { keepOpen, ...input } = p;
        const task = createTask(input);
        emitDataChanged({ reason: 'local', tasks: [task] });
        syncHooks.onLocalEdit();
        syncHooks.onTasksChanged();
        // Rapid-entry mode keeps the HUD up; the default is fire-and-forget.
        if (!keepOpen) hideQuickAdd();
        return task;
      },
    },
    'window:hideQuickAdd': {
      schema: voidSchema,
      handle: () => {
        hideQuickAdd();
      },
    },
    'window:showMain': {
      schema: z.union([z.object({ taskId: idSchema.optional() }), voidSchema]),
      handle: (p) => {
        showMainWindow();
        const taskId = p && 'taskId' in p ? p.taskId : undefined;
        if (taskId) emit({ type: 'focusTask', taskId });
      },
    },
    'window:resizeQuickAdd': {
      schema: z.object({ height: z.number().min(0).max(4000) }),
      handle: (p) => {
        resizeQuickAdd(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, p.height)));
      },
    },
  };
}
