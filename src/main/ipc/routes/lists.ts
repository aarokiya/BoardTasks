import { z } from 'zod';
import type { Routes } from '../router';
import { idSchema, listColorSchema, voidSchema } from '../schemas';
import { createList, deleteList, getAllLists, reorderLists, updateList } from '../../db/repositories/lists';
import { emitDataChanged } from '../emitter';
import { LIMITS } from '@shared/constants';
import { syncHooks } from '../../sync/hooks';

type ListRoutes = Pick<Routes, 'lists:getAll' | 'lists:create' | 'lists:update' | 'lists:reorder' | 'lists:delete'>;

export function listsRoutes(): ListRoutes {
  return {
    'lists:getAll': { schema: voidSchema, handle: () => getAllLists() },
    'lists:create': {
      schema: z.object({ title: z.string().max(LIMITS.listTitle), color: listColorSchema.optional() }),
      handle: (p) => {
        const list = createList(p);
        emitDataChanged({ reason: 'local', lists: [list] });
        syncHooks.onLocalEdit();
        return list;
      },
    },
    'lists:update': {
      schema: z.object({ id: idSchema, title: z.string().max(LIMITS.listTitle).optional(), color: listColorSchema.optional(), isDefault: z.boolean().optional() }),
      handle: (p) => {
        const list = updateList(p);
        emitDataChanged({ reason: 'local', lists: p.isDefault ? getAllLists() : [list] });
        syncHooks.onLocalEdit();
        return list;
      },
    },
    'lists:reorder': {
      schema: z.object({ orderedIds: z.array(idSchema).max(500) }),
      handle: (p) => {
        const lists = reorderLists(p.orderedIds);
        emitDataChanged({ reason: 'local', lists });
        return lists;
      },
    },
    'lists:delete': {
      schema: z.object({ id: idSchema }),
      handle: (p) => {
        const { deletedTaskIds } = deleteList(p.id);
        emitDataChanged({ reason: 'local', deletedListIds: [p.id], deletedTaskIds, lists: getAllLists() });
        syncHooks.onLocalEdit();
      },
    },
  };
}
