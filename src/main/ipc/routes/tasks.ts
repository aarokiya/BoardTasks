import type { Routes } from '../router';
import { notImplemented } from './_stub';

type TaskRoutes = Pick<Routes, 'tasks:getAll' | 'tasks:get' | 'tasks:search' | 'tasks:create' | 'tasks:update' | 'tasks:setStatus' | 'tasks:move' | 'tasks:delete' | 'tasks:restore' | 'tasks:clearCompleted' | 'tasks:resolveConflict'>;

export function tasksRoutes(): TaskRoutes {
  return {
    'tasks:getAll': notImplemented('tasks:getAll'),
    'tasks:get': notImplemented('tasks:get'),
    'tasks:search': notImplemented('tasks:search'),
    'tasks:create': notImplemented('tasks:create'),
    'tasks:update': notImplemented('tasks:update'),
    'tasks:setStatus': notImplemented('tasks:setStatus'),
    'tasks:move': notImplemented('tasks:move'),
    'tasks:delete': notImplemented('tasks:delete'),
    'tasks:restore': notImplemented('tasks:restore'),
    'tasks:clearCompleted': notImplemented('tasks:clearCompleted'),
    'tasks:resolveConflict': notImplemented('tasks:resolveConflict'),
  };
}
