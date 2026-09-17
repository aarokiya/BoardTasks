import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainEvent } from '../../../../src/shared/events';

const mocks = vi.hoisted(() => ({
  registerResult: true,
  registered: new Set<string>(),
  sent: [] as MainEvent[],
  throwOnRegister: false,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/tmp', getPath: () => '/tmp', getVersion: () => '0', on: () => {}, off: () => {} },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (_c: string, e: MainEvent) => mocks.sent.push(e) },
      },
    ],
  },
  ipcMain: { handle: () => {} },
  globalShortcut: {
    register: (accel: string) => {
      if (mocks.throwOnRegister) throw new Error('bad accelerator');
      if (!mocks.registerResult) return false;
      mocks.registered.add(accel);
      return true;
    },
    isRegistered: (accel: string) => mocks.registered.has(accel),
    unregister: (accel: string) => mocks.registered.delete(accel),
    unregisterAll: () => mocks.registered.clear(),
  },
}));

import { openDatabase, closeDatabase } from '../../../../src/main/db/connection';
import { resetSettingsCache } from '../../../../src/main/db/repositories/settings';
import { registerQuickAddShortcut } from '../../../../src/main/platform/shortcuts';

beforeEach(() => {
  openDatabase(':memory:');
  resetSettingsCache();
  mocks.registerResult = true;
  mocks.throwOnRegister = false;
  mocks.registered.clear();
  mocks.sent = [];
});
afterEach(() => closeDatabase());

const toasts = (): Extract<MainEvent, { type: 'toast' }>[] => mocks.sent.filter((e): e is Extract<MainEvent, { type: 'toast' }> => e.type === 'toast');

describe('registerQuickAddShortcut', () => {
  it('registers a valid accelerator and stays quiet', () => {
    expect(registerQuickAddShortcut('Control+Shift+Space')).toBe(true);
    expect(mocks.registered.has('Control+Shift+Space')).toBe(true);
    expect(toasts()).toHaveLength(0);
  });

  it('toasts when another app owns the shortcut', () => {
    mocks.registerResult = false;
    expect(registerQuickAddShortcut('Control+Shift+Space')).toBe(false);
    const [toast] = toasts();
    expect(toast?.level).toBe('warn');
    expect(toast?.message).toContain('Control+Shift+Space');
    expect(toast?.message).toContain('used by another app');
    expect(toast?.actionCommand).toBe('app.settings');
  });

  it('toasts on a malformed accelerator without calling into Electron', () => {
    expect(registerQuickAddShortcut('Bogus')).toBe(false);
    expect(mocks.registered.size).toBe(0);
    expect(toasts()).toHaveLength(1);
  });

  it('survives register() throwing', () => {
    mocks.throwOnRegister = true;
    expect(registerQuickAddShortcut('Control+Shift+Space')).toBe(false);
    expect(toasts()).toHaveLength(1);
  });

  it('unregisters the previous accelerator before claiming a new one', () => {
    registerQuickAddShortcut('Control+Shift+Space');
    registerQuickAddShortcut('Alt+Shift+A');
    expect([...mocks.registered]).toEqual(['Alt+Shift+A']);
  });
});
