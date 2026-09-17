import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ badges: [] as string[] }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp',
    getPath: () => '/tmp',
    getVersion: () => '0',
    on: () => {},
    off: () => {},
    dock: { setBadge: (b: string) => mocks.badges.push(b) },
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));

import { openDatabase, closeDatabase } from '../../../../src/main/db/connection';
import { createTask } from '../../../../src/main/db/repositories/tasks';
import { resetSettingsCache, setSettings } from '../../../../src/main/db/repositories/settings';
import { todayCivil } from '../../../../src/shared/date/civil';
import { addDays } from '../../../../src/shared/date/format';
import { badgeCount, badgeText, initDockBadge } from '../../../../src/main/platform/dock-badge';
import { emitResume, platformHooks, resetPlatformHooks } from '../../../../src/main/platform/hooks';

beforeEach(() => {
  openDatabase(':memory:');
  resetSettingsCache();
  resetPlatformHooks();
  mocks.badges = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  closeDatabase();
});

describe('badgeCount', () => {
  // countDue.today is "due on or before today", so it already includes overdue.
  const counts = { today: 5, overdue: 2 };
  it.each([
    ['off', 0],
    ['today', 3],
    ['overdue', 2],
    ['both', 5],
  ] as const)('%s → %i', (mode, expected) => {
    expect(badgeCount(mode, counts)).toBe(expected);
  });

  it('renders an empty badge rather than a zero', () => {
    expect(badgeText('today', { today: 0, overdue: 0 })).toBe('');
    expect(badgeText('overdue', { today: 4, overdue: 0 })).toBe('');
    expect(badgeText('both', { today: 4, overdue: 1 })).toBe('4');
  });
});

describe('initDockBadge', () => {
  it('sets the badge from the database on start', () => {
    const today = todayCivil();
    createTask({ title: 'late', due: addDays(today, -1) });
    createTask({ title: 'now', due: today });
    const dispose = initDockBadge();
    expect(mocks.badges.at(-1)).toBe('1'); // mode 'today' → due exactly today
    dispose();
  });

  it('recomputes on onTasksChanged and on a mode change', () => {
    const today = todayCivil();
    createTask({ title: 'now', due: today });
    const dispose = initDockBadge();
    expect(mocks.badges.at(-1)).toBe('1');

    createTask({ title: 'late', due: addDays(today, -3) });
    platformHooks.onTasksChanged();
    expect(mocks.badges.at(-1)).toBe('1');

    setSettings({ dockBadgeMode: 'both' });
    expect(mocks.badges.at(-1)).toBe('2');

    setSettings({ dockBadgeMode: 'off' });
    expect(mocks.badges.at(-1)).toBe('');
    dispose();
  });

  it('recomputes at local midnight without a 24h interval', () => {
    const today = todayCivil();
    createTask({ title: 'tomorrow', due: addDays(today, 1) });
    const dispose = initDockBadge();
    expect(mocks.badges.at(-1)).toBe('');

    const before = mocks.badges.length;
    // msUntilNextMidnight is computed from the (faked) clock; a full day covers it.
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(mocks.badges.length).toBeGreaterThan(before);
    dispose();
  });

  it('recomputes after a resume — a laptop that slept past midnight must not show yesterday', () => {
    const dispose = initDockBadge();
    const before = mocks.badges.length;
    emitResume();
    expect(mocks.badges.length).toBe(before + 1);
    dispose();
  });

  it('stops listening once disposed', () => {
    const dispose = initDockBadge();
    dispose();
    const before = mocks.badges.length;
    platformHooks.onTasksChanged();
    emitResume();
    setSettings({ dockBadgeMode: 'both' });
    expect(mocks.badges.length).toBe(before);
  });
});
