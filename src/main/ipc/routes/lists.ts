import type { Routes } from '../router';
import { notImplemented } from './_stub';

type ListRoutes = Pick<Routes, 'lists:getAll' | 'lists:create' | 'lists:update' | 'lists:reorder' | 'lists:delete'>;

export function listsRoutes(): ListRoutes {
  return {
    'lists:getAll': notImplemented('lists:getAll'),
    'lists:create': notImplemented('lists:create'),
    'lists:update': notImplemented('lists:update'),
    'lists:reorder': notImplemented('lists:reorder'),
    'lists:delete': notImplemented('lists:delete'),
  };
}
