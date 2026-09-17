import { app } from 'electron';
import { todayCivil } from '@shared/date/civil';
import type { DockBadgeMode } from '@shared/models';
import { createLogger } from '../logger';
import { msUntilNextMidnight } from '../util/time';
import { countDue } from '../db/repositories/tasks';
import { getSettings, onSettingsChanged } from '../db/repositories/settings';
import { platformHooks, subscribeTasksChanged } from './hooks';
import { createWakeTimer } from './wake-timer';

const log = createLogger('dock');

/**
 * `countDue.today` is "due on or before today", so it already contains the
 * overdue tasks. The modes therefore split as:
 *   today   → due exactly today
 *   overdue → past due
 *   both    → everything that is due or late (= countDue.today)
 */
export function badgeCount(mode: DockBadgeMode, counts: { today: number; overdue: number }): number {
  switch (mode) {
    case 'off':
      return 0;
    case 'today':
      return counts.today - counts.overdue;
    case 'overdue':
      return counts.overdue;
    case 'both':
      return counts.today;
  }
}

export function badgeText(mode: DockBadgeMode, counts: { today: number; overdue: number }): string {
  const n = badgeCount(mode, counts);
  return n > 0 ? String(n) : '';
}

export function initDockBadge(): () => void {
  const midnight = createWakeTimer(() => {
    refresh();
    armMidnight();
  });
  const armMidnight = (): void => midnight.armIn(msUntilNextMidnight());

  const refresh = (): void => {
    try {
      const mode = getSettings().dockBadgeMode;
      app.dock?.setBadge(badgeText(mode, countDue(todayCivil())));
    } catch (e) {
      log.error('badge update failed', e);
    }
  };

  refresh();
  armMidnight();

  const offTasks = subscribeTasksChanged(refresh);
  const offSettings = onSettingsChanged((_s, changed) => {
    if (changed.includes('dockBadgeMode')) refresh();
  });
  // A laptop that slept past midnight must not keep yesterday's count.
  const offResume = platformHooks.onResume(() => {
    refresh();
    armMidnight();
  });

  return () => {
    midnight.cancel();
    offTasks();
    offSettings();
    offResume();
  };
}
