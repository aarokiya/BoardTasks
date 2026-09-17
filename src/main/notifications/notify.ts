import { Notification, type NotificationAction } from 'electron';
import { todayCivil } from '@shared/date/civil';
import { formatDueWithTime } from '@shared/date/format';
import type { Task } from '@shared/models';
import { createLogger } from '../logger';
import { getList } from '../db/repositories/lists';
import { setStatus } from '../db/repositories/tasks';
import { getSettings } from '../db/repositories/settings';
import { emitDataChanged } from '../ipc/emitter';
import { syncHooks } from '../sync/hooks';
import { windowHooks } from '../windows/hooks';
import { platformHooks } from '../platform/hooks';

const log = createLogger('notify');

const COMPLETE_ACTION_INDEX = 0;

function body(task: Task): string {
  const parts: string[] = [];
  if (task.due) parts.push(formatDueWithTime(task.due, task.dueTime, todayCivil()));
  const list = task.listId ? getList(task.listId) : null;
  if (list) parts.push(list.title);
  return parts.join(' · ');
}

/** Completing from the notification is a real local edit: persist, push, re-badge. */
function completeFromNotification(taskId: string): void {
  try {
    const tasks = setStatus([taskId], true);
    emitDataChanged({ reason: 'local', tasks });
    syncHooks.onLocalEdit();
    platformHooks.onTasksChanged();
    log.info(`completed ${taskId} from notification`);
  } catch (e) {
    log.error('complete from notification failed', e);
  }
}

function show(opts: { title: string; body: string; onClick?: () => void; actions?: NotificationAction[]; onAction?: (index: number) => void }): boolean {
  if (!Notification.isSupported()) {
    log.warn('notifications are not supported on this system');
    return false;
  }
  try {
    const n = new Notification({
      title: opts.title,
      body: opts.body,
      silent: false,
      ...(opts.actions ? { actions: opts.actions } : {}),
    });
    if (opts.onClick) n.on('click', opts.onClick);
    if (opts.onAction) n.on('action', (_e, index) => opts.onAction?.(index));
    n.show();
    return true;
  } catch (e) {
    log.error('failed to show notification', e);
    return false;
  }
}

export function sendTaskNotification(task: Task): boolean {
  if (!getSettings().notificationsEnabled) return false;
  const title = task.title.trim() || 'Untitled task';
  const sent = show({
    title,
    body: body(task),
    onClick: () => windowHooks.focusTask(task.id),
    // macOS only renders actions in "alert" style banners; harmless otherwise.
    actions: [{ type: 'button', text: 'Complete' }],
    onAction: (index) => {
      if (index === COMPLETE_ACTION_INDEX) completeFromNotification(task.id);
    },
  });
  log.info(`reminder ${sent ? 'sent' : 'suppressed'} for ${task.id} "${title}"`);
  return sent;
}

/** One line instead of a burst after the app was closed for a while. */
export function sendMissedSummary(count: number): boolean {
  if (count <= 0 || !getSettings().notificationsEnabled) return false;
  const sent = show({
    title: 'BoardTasks',
    body: `${count} reminder${count === 1 ? ' was' : 's were'} missed while BoardTasks was closed.`,
    onClick: () => windowHooks.showMain(),
  });
  log.info(`missed-reminder summary (${count}) ${sent ? 'sent' : 'suppressed'}`);
  return sent;
}

/**
 * macOS never exposes whether the user granted notification permission, so the
 * settings screen offers this instead. Deliberately ignores
 * `notificationsEnabled`: the user asked for it explicitly, right now.
 */
export function sendTestNotification(): boolean {
  const sent = show({
    title: 'BoardTasks',
    body: 'Notifications are working. Reminders will appear like this.',
    onClick: () => windowHooks.showMain(),
  });
  log.info(`test notification ${sent ? 'sent' : 'failed'}`);
  return sent;
}
