import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Shown {
  title: string;
  body: string;
  listeners: Map<string, (e: unknown, index?: number) => void>;
}

const mocks = vi.hoisted(() => ({ shown: [] as Shown[], supported: true }));

vi.mock('electron', () => {
  class FakeNotification {
    static isSupported = (): boolean => mocks.supported;
    private readonly entry: Shown;
    constructor(opts: { title: string; body: string }) {
      this.entry = { title: opts.title, body: opts.body, listeners: new Map() };
    }
    on(event: string, cb: (e: unknown, index?: number) => void): this {
      this.entry.listeners.set(event, cb);
      return this;
    }
    show(): void {
      mocks.shown.push(this.entry);
    }
  }
  return {
    app: { isPackaged: false, getAppPath: () => '/tmp', getPath: () => '/tmp', getVersion: () => '0', on: () => {}, off: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
    Notification: FakeNotification,
  };
});

import { openDatabase, closeDatabase } from '../../../../src/main/db/connection';
import { createTask, getTask } from '../../../../src/main/db/repositories/tasks';
import { createList } from '../../../../src/main/db/repositories/lists';
import { resetSettingsCache, setSettings } from '../../../../src/main/db/repositories/settings';
import { todayCivil } from '../../../../src/shared/date/civil';
import { sendMissedSummary, sendTaskNotification, sendTestNotification } from '../../../../src/main/notifications/notify';
import { installWindowHooks } from '../../../../src/main/windows/hooks';
import { installSyncHooks } from '../../../../src/main/sync/hooks';
import { resetPlatformHooks, subscribeTasksChanged } from '../../../../src/main/platform/hooks';

beforeEach(() => {
  openDatabase(':memory:');
  resetSettingsCache();
  resetPlatformHooks();
  mocks.shown = [];
  mocks.supported = true;
  installWindowHooks({ showMain: () => {}, focusTask: () => {}, showQuickAdd: () => {}, toggleQuickAdd: () => {}, hideQuickAdd: () => {} });
  installSyncHooks({ onLocalEdit: () => {}, onTasksChanged: () => {} });
});
afterEach(() => closeDatabase());

describe('sendTaskNotification', () => {
  it('titles with the task and bodies with the due label and list name', () => {
    const list = createList({ title: 'Work', color: 'blue' });
    const t = createTask({ title: 'Ship it', listId: list.id, due: todayCivil(), dueTime: '14:00' });
    expect(sendTaskNotification(getTask(t.id)!)).toBe(true);
    expect(mocks.shown[0]?.title).toBe('Ship it');
    expect(mocks.shown[0]?.body).toBe('Today 2 PM · Work');
  });

  it('falls back to a placeholder title', () => {
    const t = createTask({ title: '   ', due: todayCivil() });
    sendTaskNotification(getTask(t.id)!);
    expect(mocks.shown[0]?.title).toBe('Untitled task');
  });

  it('respects notificationsEnabled', () => {
    setSettings({ notificationsEnabled: false });
    const t = createTask({ title: 'Quiet', due: todayCivil() });
    expect(sendTaskNotification(getTask(t.id)!)).toBe(false);
    expect(mocks.shown).toHaveLength(0);
  });

  it('reports failure when the platform has no notification support', () => {
    mocks.supported = false;
    const t = createTask({ title: 'x' });
    expect(sendTaskNotification(getTask(t.id)!)).toBe(false);
  });

  it('click focuses the task through the window seam', () => {
    const focusTask = vi.fn();
    installWindowHooks({ focusTask });
    const t = createTask({ title: 'Focus me' });
    sendTaskNotification(getTask(t.id)!);
    mocks.shown[0]?.listeners.get('click')?.(null);
    expect(focusTask).toHaveBeenCalledWith(t.id);
  });

  it('the Complete action writes the change, pushes it and re-badges', () => {
    const onLocalEdit = vi.fn();
    const onTasksChanged = vi.fn();
    installSyncHooks({ onLocalEdit });
    subscribeTasksChanged(onTasksChanged);
    const t = createTask({ title: 'Do it', due: todayCivil() });
    sendTaskNotification(getTask(t.id)!);

    mocks.shown[0]?.listeners.get('action')?.(null, 0);
    expect(getTask(t.id)!.status).toBe('completed');
    expect(onLocalEdit).toHaveBeenCalledTimes(1);
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
  });
});

describe('summary and test notifications', () => {
  it('summarises missed reminders in one line', () => {
    expect(sendMissedSummary(3)).toBe(true);
    expect(mocks.shown[0]?.body).toBe('3 reminders were missed while BoardTasks was closed.');
    expect(sendMissedSummary(1)).toBe(true);
    expect(mocks.shown[1]?.body).toBe('1 reminder was missed while BoardTasks was closed.');
  });

  it('never shows an empty summary', () => {
    expect(sendMissedSummary(0)).toBe(false);
    expect(mocks.shown).toHaveLength(0);
  });

  // macOS never exposes permission state, so this is the only way to check.
  it('sends a test notification even when reminders are switched off', () => {
    setSettings({ notificationsEnabled: false });
    expect(sendTestNotification()).toBe(true);
    expect(mocks.shown).toHaveLength(1);
  });
});
