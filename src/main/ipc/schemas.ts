import { z } from 'zod';
import { GOOGLE_CLIENT_ID_RE, ID_RE, LIMITS } from '@shared/constants';
import { isCivil, TIME_RE } from '@shared/date/civil';
import { LIST_COLORS } from '@shared/models';

export const idSchema = z.string().regex(ID_RE, 'invalid id');
export const idsSchema = z.array(idSchema).min(1).max(500);
export const opIdSchema = z.string().max(64).optional();
export const civilSchema = z.string().refine(isCivil, 'invalid date');
export const timeSchema = z.string().regex(TIME_RE, 'invalid time');
export const listColorSchema = z.enum(LIST_COLORS as unknown as [string, ...string[]]);
export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const previousIdSchema = z.union([idSchema, z.literal('end'), z.null()]);

export const voidSchema = z.undefined().or(z.null()).transform(() => undefined);

export const taskCreateSchema = z.object({
  opId: opIdSchema,
  listId: idSchema.optional(),
  title: z.string().max(LIMITS.taskTitle),
  notes: z.string().max(LIMITS.taskNotes).optional(),
  due: civilSchema.nullable().optional(),
  dueTime: timeSchema.nullable().optional(),
  parentId: idSchema.nullable().optional(),
  previousId: previousIdSchema.optional(),
  priority: prioritySchema.optional(),
  flagged: z.boolean().optional(),
  githubUrl: z.string().url().max(2048).nullable().optional(),
});

export const taskUpdateSchema = z.object({
  opId: opIdSchema,
  id: idSchema,
  patch: z
    .object({
      title: z.string().max(LIMITS.taskTitle),
      notes: z.string().max(LIMITS.taskNotes),
      due: civilSchema.nullable(),
      dueTime: timeSchema.nullable(),
      priority: prioritySchema,
      flagged: z.boolean(),
      status: z.enum(['needsAction', 'completed']),
    })
    .partial(),
});

export const taskMoveSchema = z.object({
  opId: opIdSchema,
  id: idSchema,
  listId: idSchema.optional(),
  parentId: idSchema.nullable(),
  previousId: previousIdSchema,
});

export const clientIdSchema = z.string().trim().regex(GOOGLE_CLIENT_ID_RE, 'That does not look like a Google OAuth client ID (…apps.googleusercontent.com)');
export const clientSecretSchema = z.string().trim().min(8).max(256);
export const urlSchema = z.string().url().max(2048);
