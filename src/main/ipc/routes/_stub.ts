import type { Channel } from '@shared/ipc';
import { z } from 'zod';
import type { Route } from '../router';
import { AppError } from '../errors';

/** Placeholder for a channel a feature track has not implemented yet. */
export function notImplemented<C extends Channel>(channel: C): Route<C> {
  return {
    schema: z.unknown(),
    handle: () => {
      throw new AppError('INTERNAL', `${channel} is not implemented yet`);
    },
  } as unknown as Route<C>;
}
