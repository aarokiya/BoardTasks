import type { Routes } from '../router';
import { notImplemented } from './_stub';

type NotificationRoutes = Pick<Routes, 'notifications:test' | 'notifications:openSystemSettings'>;

export function notificationsRoutes(): NotificationRoutes {
  return {
    'notifications:test': notImplemented('notifications:test'),
    'notifications:openSystemSettings': notImplemented('notifications:openSystemSettings'),
  };
}
