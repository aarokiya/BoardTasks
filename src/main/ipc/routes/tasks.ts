import { z } from 'zod';
import type { Routes } from '../router';
import { idSchema, idsSchema, opIdSchema, taskCreateSchema, taskMoveSchema, taskUpdateSchema, voidSchema } from '../schemas';
import { clearCompleted, createTask, deleteTasks, getAllTasks, getTask, getTasks, moveTask, resolveConflict, restoreTasks, searchTasks, setStatus, updateTask } from '../../db/repositories/tasks';
import { emitDataChanged } from '../emitter';
import { syncHooks } from '../../sync/hooks';
import { githubHooks } from '../../github/hooks';

type TaskRoutes = Pick<Routes, 'tasks:getAll' | 'tasks:get' | 'tasks:search' | 'tasks:create' | 'tasks:update' | 'tasks:setStatus' | 'tasks:move' | 'tasks:delete' | 'tasks:restore' | 'tasks:clearCompleted' | 'tasks:resolveConflict'>;

export function tasksRoutes(): TaskRoutes {
  return {
    'tasks:getAll': { schema: voidSchema, handle: () => getAllTasks() },
    'tasks:get': { schema: z.object({ id: idSchema }), handle: (p) => getTask(p.id) },
    'tasks:search': { schema: z.object({ q: z.string().max(512), limit: z.number().int().min(1).max(200).optional() }), handle: (p) => searchTasks(p.q, p.limit) },
    'tasks:create': {
      schema: taskCreateSchema,
      handle: async (p) => {
        let task = createTask(p);
        emitDataChanged({ reason: 'local', tasks: [task] });
        syncHooks.onLocalEdit();
        if (p.githubUrl) {
          const linked = await githubHooks.linkUrl(task.id, p.githubUrl).catch(() => null);
          if (linked) task = linked;
        }
        return task;
      },
    },
    'tasks:update': {
      schema: taskUpdateSchema,
      handle: (p) => {
        const task = updateTask(p);
        emitDataChanged({ reason: 'local', tasks: [task] });
        syncHooks.onLocalEdit();
        syncHooks.onTasksChanged();
        return task;
      },
    },
    'tasks:setStatus': {
      schema: z.object({ opId: opIdSchema, ids: idsSchema, completed: z.boolean() }),
      handle: (p) => {
        const tasks = setStatus(p.ids, p.completed);
        emitDataChanged({ reason: 'local', tasks });
        syncHooks.onLocalEdit();
        syncHooks.onTasksChanged();
        return tasks;
      },
    },
    'tasks:move': {
      schema: taskMoveSchema,
      handle: (p) => {
        const task = moveTask(p);
        // Children may have changed list; re-send the affected subtree.
        const tasks = [task, ...getAllTasks().filter((t) => t.parentId === task.id)];
        emitDataChanged({ reason: 'local', tasks });
        syncHooks.onLocalEdit();
        return task;
      },
    },
    'tasks:delete': {
      schema: z.object({ opId: opIdSchema, ids: idsSchema }),
      handle: (p) => {
        const { deletedIds } = deleteTasks(p.ids);
        emitDataChanged({ reason: 'local', deletedTaskIds: deletedIds });
        syncHooks.onLocalEdit();
        syncHooks.onTasksChanged();
      },
    },
    'tasks:restore': {
      schema: z.object({ ids: idsSchema }),
      handle: (p) => {
        const tasks = restoreTasks(p.ids);
        emitDataChanged({ reason: 'local', tasks });
        syncHooks.onLocalEdit();
        syncHooks.onTasksChanged();
        return tasks;
      },
    },
    'tasks:clearCompleted': {
      schema: z.object({ listId: idSchema }),
      handle: (p) => {
        const { changedIds } = clearCompleted(p.listId);
        emitDataChanged({ reason: 'local', tasks: getTasks(changedIds) });
        syncHooks.onLocalEdit();
      },
    },
    'tasks:resolveConflict': {
      schema: z.object({ id: idSchema, resolution: z.enum(['keepLocal', 'useServer', 'restore', 'discard']) }),
      handle: (p) => {
        const task = resolveConflict(p.id, p.resolution);
        if (task) emitDataChanged({ reason: 'local', tasks: [task] });
        else emitDataChanged({ reason: 'local', deletedTaskIds: [p.id] });
        syncHooks.onLocalEdit();
        return task;
      },
    },
  };
}
