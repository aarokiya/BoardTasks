/**
 * One re-armable wake timer for every reminder in the app.
 *
 * A timer per task does not survive contact with reality: 2000 tasks is 2000
 * live handles, none of them correct after a sleep/wake, a timezone change or a
 * clock adjustment. Instead we compute the single next instant, sleep until it,
 * fire, and recompute.
 *
 * Every input is injected so the whole thing runs under fake timers.
 */
import { localInstant, todayCivil } from '@shared/date/civil';
import type { Settings, Task } from '@shared/models';
import { createLogger, type Logger } from '../logger';
import { msUntilNextMidnight } from '../util/time';
import { createWakeTimer } from '../platform/wake-timer';
import { platformHooks, subscribeTasksChanged } from '../platform/hooks';
import { getSettings, onSettingsChanged } from '../db/repositories/settings';
import { tasksWithDue } from '../db/repositories/tasks';
import { computeBacklog, computeNextFire, sentKey } from './compute';
import { loadSentKeys, markSent, pruneSent, SUMMARY_TASK_ID } from './sent';
import { sendMissedSummary, sendTaskNotification } from './notify';

const log = createLogger('reminders');

/** How often we check whether wall-clock time moved independently of elapsed time. */
export const DRIFT_TICK_MS = 60_000;
/** Above this the machine slept or the clock was set: the armed instant is meaningless. */
export const DRIFT_THRESHOLD_MS = 30_000;

/** Guards against a rule bug turning "fire then recompute" into a spin. */
export const MAX_FIRES_PER_PASS = 200;

/** Settings changes that alter when a reminder fires. */
const REMINDER_SETTINGS: readonly (keyof Settings)[] = ['notificationsEnabled', 'notificationLeadMinutes', 'dateOnlyReminderTime'];

/** Declared as properties, not methods, so `deps.now` can be passed around unbound. */
export interface SchedulerDeps {
  now: () => number;
  /** Monotonic ms; only differences matter. Injected because fake timers need not fake performance. */
  monotonic: () => number;
  listTasks: () => Task[];
  readSettings: () => Settings;
  loadSent: () => Set<string>;
  markSent: (taskId: string, fireAt: number) => void;
  notify: (task: Task) => void;
  notifySummary: (count: number) => void;
  onSettingsChanged: (l: (s: Settings, changed: (keyof Settings)[]) => void) => () => void;
  onTasksChanged: (cb: () => void) => () => void;
  onResume: (cb: () => void) => () => void;
  log: Logger;
}

export interface NotificationScheduler {
  start(): void;
  stop(): void;
  /** Recompute and re-arm. Safe to call at any frequency. */
  rearm(): void;
  /** The instant currently armed for, or null. For tests and diagnostics. */
  armedFor(): number | null;
}

export function createNotificationScheduler(deps: SchedulerDeps): NotificationScheduler {
  let running = false;
  let drift: ReturnType<typeof setInterval> | null = null;
  let wallBase = 0;
  let monoBase = 0;
  const unsubscribes: Array<() => void> = [];

  const timer = createWakeTimer(() => rearm(), deps.now);
  // "Today" moving matters even though nothing fires at midnight: the date-only
  // reminder time and the due labels both resolve against it.
  const midnight = createWakeTimer(() => {
    armMidnight();
    rearm();
  }, deps.now);

  const armMidnight = (): void => midnight.armIn(msUntilNextMidnight(new Date(deps.now())));

  const resetDriftBaseline = (): void => {
    wallBase = deps.now();
    monoBase = deps.monotonic();
  };

  function rearm(): void {
    if (!running) return;
    try {
      const settings = deps.readSettings();
      const sent = deps.loadSent();
      let fired = 0;
      for (;;) {
        const now = deps.now();
        const tasks = deps.listTasks();
        const next = computeNextFire(tasks, settings, now, sent);
        if (!next) {
          timer.cancel();
          return;
        }
        if (next.at > now) {
          timer.armAt(next.at);
          deps.log.debug(`next reminder in ${Math.round((next.at - now) / 1000)}s for ${next.taskIds.length} task(s)`);
          return;
        }
        // Due now, or missed inside the backlog window while asleep: fire and recompute.
        for (const id of next.taskIds) {
          sent.add(sentKey(id, next.at));
          deps.markSent(id, next.at);
          const task = tasks.find((t) => t.id === id);
          if (task) deps.notify(task);
          fired++;
        }
        if (fired >= MAX_FIRES_PER_PASS) {
          deps.log.warn(`stopped after ${fired} reminders in one pass; re-arming shortly`);
          timer.armIn(1000);
          return;
        }
      }
    } catch (e) {
      deps.log.error('re-arm failed; retrying in 60s', e);
      timer.armIn(DRIFT_TICK_MS);
    }
  }

  /**
   * Reminders that elapsed more than 24h ago while the app was closed. They are
   * marked sent and reported as a single line — never as a wall of banners —
   * and at most once per calendar day.
   */
  function drainBacklog(): void {
    try {
      const settings = deps.readSettings();
      const sent = deps.loadSent();
      const now = deps.now();
      const missed = computeBacklog(deps.listTasks(), settings, now, sent);
      if (missed.length === 0) return;
      for (const m of missed) deps.markSent(m.id, m.at);
      const dayStart = localInstant(todayCivil(new Date(now)), '00:00');
      if (sent.has(sentKey(SUMMARY_TASK_ID, dayStart))) {
        deps.log.info(`${missed.length} missed reminder(s) suppressed; summary already shown today`);
        return;
      }
      deps.markSent(SUMMARY_TASK_ID, dayStart);
      deps.notifySummary(missed.length);
    } catch (e) {
      deps.log.error('backlog drain failed', e);
    }
  }

  function tickDrift(): void {
    const wall = deps.now() - wallBase;
    const mono = deps.monotonic() - monoBase;
    const delta = wall - mono;
    resetDriftBaseline();
    if (Math.abs(delta) > DRIFT_THRESHOLD_MS) {
      deps.log.info(`clock drift ${Math.round(delta / 1000)}s detected; re-arming`);
      armMidnight();
      rearm();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      resetDriftBaseline();
      drainBacklog();
      armMidnight();
      rearm();

      unsubscribes.push(
        deps.onSettingsChanged((_s, changed) => {
          if (REMINDER_SETTINGS.some((k) => changed.includes(k))) rearm();
        }),
        deps.onTasksChanged(() => rearm()),
        deps.onResume(() => {
          armMidnight();
          rearm();
        }),
      );

      drift = setInterval(tickDrift, DRIFT_TICK_MS);
      drift.unref?.();
    },
    stop() {
      running = false;
      timer.cancel();
      midnight.cancel();
      if (drift) {
        clearInterval(drift);
        drift = null;
      }
      while (unsubscribes.length) unsubscribes.pop()?.();
    },
    rearm,
    armedFor: () => timer.armedFor(),
  };
}

export function initNotificationScheduler(): () => void {
  pruneSent();
  const scheduler = createNotificationScheduler({
    now: Date.now,
    monotonic: () => performance.now(),
    listTasks: tasksWithDue,
    readSettings: getSettings,
    loadSent: loadSentKeys,
    markSent,
    notify: sendTaskNotification,
    notifySummary: sendMissedSummary,
    onSettingsChanged,
    onTasksChanged: subscribeTasksChanged,
    onResume: (cb) => platformHooks.onResume(cb),
    log,
  });
  scheduler.start();
  log.info('notification scheduler started');
  return () => scheduler.stop();
}
