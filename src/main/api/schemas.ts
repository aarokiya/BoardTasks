import { z } from 'zod';

/**
 * Wire shapes for the two Google Tasks resources.
 *
 * Every object is a LOOSE object (passthrough): Google adds fields without
 * warning, and a strict schema would turn a harmless new field into a hard
 * sync failure. We validate the fields we depend on and carry the rest along.
 */

const linkSchema = z.looseObject({
  type: z.string().optional(),
  description: z.string().optional(),
  link: z.string().optional(),
});

export const gTaskSchema = z.looseObject({
  kind: z.string().optional(),
  id: z.string().min(1),
  etag: z.string().optional(),
  title: z.string().optional(),
  updated: z.string().optional(),
  selfLink: z.string().optional(),
  /** Output-only. You cannot set hierarchy in a request body. */
  parent: z.string().optional(),
  /** Output-only, opaque, lexicographic. Never parse it, never compute one. */
  position: z.string().optional(),
  notes: z.string().nullable().optional(),
  status: z.enum(['needsAction', 'completed']).optional(),
  /** RFC3339, but the time component is meaningless — it is a calendar date. */
  due: z.string().nullable().optional(),
  completed: z.string().nullable().optional(),
  deleted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  webViewLink: z.string().optional(),
  links: z.array(linkSchema).optional(),
});

export const gTaskListSchema = z.looseObject({
  kind: z.string().optional(),
  id: z.string().min(1),
  etag: z.string().optional(),
  title: z.string().optional(),
  updated: z.string().optional(),
  selfLink: z.string().optional(),
});

export const gTasksPageSchema = z.looseObject({
  kind: z.string().optional(),
  etag: z.string().optional(),
  nextPageToken: z.string().optional(),
  items: z.array(gTaskSchema).optional(),
});

export const gTaskListsPageSchema = z.looseObject({
  kind: z.string().optional(),
  etag: z.string().optional(),
  nextPageToken: z.string().optional(),
  items: z.array(gTaskListSchema).optional(),
});

export type GTask = z.infer<typeof gTaskSchema>;
export type GTaskList = z.infer<typeof gTaskListSchema>;
export type GTasksPage = z.infer<typeof gTasksPageSchema>;
export type GTaskListsPage = z.infer<typeof gTaskListsPageSchema>;

/** Body accepted by tasks.insert / tasks.patch. parent/position are output-only and never sent. */
export interface TaskWriteBody {
  title?: string;
  notes?: string | null;
  status?: 'needsAction' | 'completed';
  due?: string | null;
  completed?: string | null;
}

export class SchemaError extends Error {
  readonly kind = 'schema' as const;
  readonly retryable = false;
  constructor(
    readonly what: string,
    readonly issues: string,
  ) {
    super(`Unexpected response shape from Google (${what}): ${issues}`);
    this.name = 'SchemaError';
  }
}

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues = r.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  throw new SchemaError(what, issues);
}
