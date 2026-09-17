import type { Routes } from './router';
import { appRoutes } from './routes/app';
import { authRoutes } from './routes/auth';
import { listsRoutes } from './routes/lists';
import { tasksRoutes } from './routes/tasks';
import { syncRoutes } from './routes/sync';
import { settingsRoutes } from './routes/settings';
import { githubRoutes } from './routes/github';
import { notificationsRoutes } from './routes/notifications';
import { windowRoutes } from './routes/window';

/** Exhaustive by type: a channel missing from every module is a compile error. */
export function buildRoutes(): Routes {
  return {
    ...appRoutes(),
    ...authRoutes(),
    ...listsRoutes(),
    ...tasksRoutes(),
    ...syncRoutes(),
    ...settingsRoutes(),
    ...githubRoutes(),
    ...notificationsRoutes(),
    ...windowRoutes(),
  };
}
