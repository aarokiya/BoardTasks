import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationScheduler, DRIFT_TICK_MS, type SchedulerDeps } from '../../../../src/main/notifications/scheduler';
import { sentKey } from '../../../../src/main/notifications/compute';
import { asCivil, localInstant } from '../../../../src/shared/date/civil';
import { MAX_TIMER_MS } from '../../../../src/main/util/time';
import { DEFAULT_SETTINGS, type Settings, type Task } from '../../../../src/shared/models';

const DAY = asCivil('2026-09-17');
const at = (time: string, day = DAY): number => localInstant(day, time);

function task(id: string, dueTime: string | null, over: Partial<Task> = {}): Task {
  return {
    id,
    remoteId: null,
    listId: 'list-1',
    title: id,
    notes: '',
    status: 'needsAction',
    due: DAY,
    dueTime,
    completedAt: null,
    parentId: null,
    sortKey: 'a0',
    priority: 0,
    flagged: false,
    hidden: false,
    deleted: false,
    webViewLink: null,
    links: [],
    github: null,
    sync: 'synced',
    conflict: null,
    rev: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: null,
    localUpdatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

interface Harness {
  deps: SchedulerDeps;
  notified: string[];
  summaries: number[];
  sent: Set<string>;
  tasks: Task[];
  setSettings(patch: Partial<Settings>): void;
  fireTasksChanged(): void;
  fireResume(): void;
  /** Wall clock offset applied on top of the fake timers' clock. */
  skew: number;
}

function harness(initial: Task[], over: Partial<Settings> = {}): Harness {
  let settings: Settings = { ...DEFAULT_SETTINGS, notificationLeadMinutes: 0, ...over };
  const settingsListeners = new Set<(s: Settings, c: (keyof Settings)[]) => void>();
  const taskListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();
  const notified: string[] = [];
  const summaries: number[] = [];
  const sent = new Set<string>();

  const h: Harness = {
    notified,
    summaries,
    sent,
    tasks: [...initial],
    skew: 0,
    deps: {
      // Wall clock = fake timer clock + an explicit skew, so a test can model a
      // laptop that slept (timers frozen, real time moved) or a clock change.
      now: () => Date.now() + h.skew,
      monotonic: () => Date.now(),
      listTasks: () => h.tasks,
      readSettings: () => settings,
      loadSent: () => new Set(sent),
      markSent: (taskId, fireAt) => sent.add(sentKey(taskId, fireAt)),
      notify: (t) => notified.push(t.id),
      notifySummary: (n) => summaries.push(n),
      onSettingsChanged: (l) => {
        settingsListeners.add(l);
        return () => settingsListeners.delete(l);
      },
      onTasksChanged: (cb) => {
        taskListeners.add(cb);
        return () => taskListeners.delete(cb);
      },
      onResume: (cb) => {
        resumeListeners.add(cb);
        return () => resumeListeners.delete(cb);
      },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    },
    setSettings: (patch) => {
      settings = { ...settings, ...patch };
      for (const l of settingsListeners) l(settings, Object.keys(patch) as (keyof Settings)[]);
    },
    fireTasksChanged: () => {
      for (const cb of taskListeners) cb();
    },
    fireResume: () => {
      for (const cb of resumeListeners) cb();
    },
  };
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at('08:00')));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('notification scheduler', () => {
  it('arms one timer for the next reminder and fires it once', () => {
    const h = harness([task('a', '09:00'), task('b', '17:00')]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    expect(s.armedFor()).toBe(at('09:00'));

    vi.advanceTimersByTime(59 * 60_000);
    expect(h.notified).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(h.notified).toEqual(['a']);
    // Immediately re-armed for the next one, and 'a' is recorded as sent.
    expect(s.armedFor()).toBe(at('17:00'));
    expect(h.sent.has(sentKey('a', at('09:00')))).toBe(true);

    vi.advanceTimersByTime(8 * 3600_000);
    expect(h.notified).toEqual(['a', 'b']);
    expect(s.armedFor()).toBeNull();
    s.stop();
  });

  it('fires every task sharing an instant in one pass', () => {
    const h = harness([task('a', '09:00'), task('b', '09:00')]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    vi.advanceTimersByTime(3600_000);
    expect(h.notified.sort()).toEqual(['a', 'b']);
    s.stop();
  });

  it('chunks a far-future reminder past the 2^31-1 setTimeout ceiling', () => {
    const far = asCivil('2029-01-01');
    const h = harness([task('far', '09:00', { due: far })]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    const target = at('09:00', far);
    expect(s.armedFor()).toBe(target);
    expect(target - Date.now()).toBeGreaterThan(MAX_TIMER_MS);

    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(h.notified).toEqual([]); // would have fired immediately without chunking
    vi.advanceTimersByTime(target - Date.now());
    expect(h.notified).toEqual(['far']);
    s.stop();
  });

  it('re-arms when a task changes', () => {
    const h = harness([task('a', '17:00')]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    expect(s.armedFor()).toBe(at('17:00'));

    h.tasks = [task('a', '17:00'), task('urgent', '08:30')];
    h.fireTasksChanged();
    expect(s.armedFor()).toBe(at('08:30'));
    s.stop();
  });

  it('re-arms when the lead time or the date-only time changes', () => {
    const h = harness([task('a', '09:00')]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    h.setSettings({ notificationLeadMinutes: 30 });
    expect(s.armedFor()).toBe(at('08:30'));

    h.setSettings({ notificationsEnabled: false });
    expect(s.armedFor()).toBeNull();
    s.stop();
  });

  it('re-arms on resume', () => {
    const h = harness([task('a', '17:00')]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    h.tasks = [task('a', '17:00'), task('b', '09:00')];
    h.fireResume();
    expect(s.armedFor()).toBe(at('09:00'));
    s.stop();
  });

  it('fires a reminder that elapsed during sleep, inside the 24h window', () => {
    const h = harness([task('a', '09:00')]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    // The machine slept: timers did not run, but the wall clock moved 6 hours.
    h.skew = 6 * 3600_000;
    h.fireResume();
    expect(h.notified).toEqual(['a']);
    s.stop();
  });

  it('re-arms when wall clock and monotonic time disagree by more than 30s', () => {
    const h = harness([task('a', '17:00')]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    h.tasks = [task('a', '17:00'), task('b', '09:00')];

    h.skew = 20_000; // under the threshold: no re-arm
    vi.advanceTimersByTime(DRIFT_TICK_MS);
    expect(s.armedFor()).toBe(at('17:00'));

    h.skew = 20_000 + 120_000; // clock jumped two minutes: re-arm
    vi.advanceTimersByTime(DRIFT_TICK_MS);
    expect(s.armedFor()).toBe(at('09:00'));
    s.stop();
  });

  it('summarises a backlog instead of firing it, at most once a day', () => {
    const h = harness([task('old1', '09:00'), task('old2', '10:00')]);
    vi.setSystemTime(new Date(at('12:00', asCivil('2026-09-19'))));
    const s = createNotificationScheduler(h.deps);
    s.start();
    expect(h.notified).toEqual([]);
    expect(h.summaries).toEqual([2]);
    s.stop();

    // A further backlog on the same day is recorded but not announced again.
    h.tasks = [...h.tasks, task('old3', '11:00')];
    const s2 = createNotificationScheduler(h.deps);
    s2.start();
    expect(h.summaries).toEqual([2]);
    expect(h.sent.has(sentKey('old3', at('11:00')))).toBe(true);
    s2.stop();
  });

  it('never re-fires a reminder recorded in a previous run', () => {
    const h = harness([task('a', '09:00')]);
    h.sent.add(sentKey('a', at('09:00')));
    const s = createNotificationScheduler(h.deps);
    s.start();
    vi.advanceTimersByTime(4 * 3600_000);
    expect(h.notified).toEqual([]);
    s.stop();
  });

  it('stop() releases the timers and the subscriptions', () => {
    const h = harness([task('a', '09:00')]);
    const s = createNotificationScheduler(h.deps);
    s.start();
    s.stop();
    h.fireTasksChanged();
    h.fireResume();
    vi.advanceTimersByTime(24 * 3600_000);
    expect(h.notified).toEqual([]);
    expect(s.armedFor()).toBeNull();
  });
});
