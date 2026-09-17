import { shell } from 'electron';
import type { Routes } from '../router';
import { voidSchema } from '../schemas';
import { createLogger } from '../../logger';
import { sendTestNotification } from '../../notifications/notify';

const log = createLogger('notifications');

/**
 * Deep link into System Settings ▸ Notifications. This deliberately bypasses
 * `openExternalChecked`, whose allowlist is https-only: the target is a fixed
 * Apple system URL with no user input in it, and macOS gives no API to read
 * notification permission, so this is the only way to help a user who has
 * denied it.
 */
export const MACOS_NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

type NotificationRoutes = Pick<Routes, 'notifications:test' | 'notifications:openSystemSettings'>;

export function notificationsRoutes(): NotificationRoutes {
  return {
    'notifications:test': {
      schema: voidSchema,
      handle: () => ({ sent: sendTestNotification() }),
    },
    'notifications:openSystemSettings': {
      schema: voidSchema,
      handle: () => {
        void shell.openExternal(MACOS_NOTIFICATION_SETTINGS_URL).catch((e: unknown) => log.warn('could not open notification settings', e));
      },
    },
  };
}
