import { describe, expect, it, vi } from 'vitest';

// login-item.ts imports electron only for its default (real-app) wiring.
vi.mock('electron', () => ({ app: { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings: () => {} } }));

import { installLoginItem, reconcileLoginItem, type LoginItemDeps } from '../../../../src/main/platform/login-item';
import { DEFAULT_SETTINGS, type Settings } from '../../../../src/shared/models';

type Listener = (s: Settings, changed: (keyof Settings)[]) => void;

function harness(opts: { system: boolean; stored: boolean }): {
  deps: LoginItemDeps;
  setOpenAtLogin: ReturnType<typeof vi.fn>;
  writeSettings: ReturnType<typeof vi.fn>;
  change(patch: Partial<Settings>): void;
  system(): boolean;
} {
  let system = opts.system;
  let settings: Settings = { ...DEFAULT_SETTINGS, startAtLogin: opts.stored };
  const listeners = new Set<Listener>();
  const setOpenAtLogin = vi.fn((v: boolean) => {
    system = v;
  });
  const writeSettings = vi.fn((patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
  });
  return {
    deps: {
      getOpenAtLogin: () => system,
      setOpenAtLogin,
      readSettings: () => settings,
      writeSettings,
      onSettingsChanged: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    setOpenAtLogin,
    writeSettings,
    change(patch) {
      settings = { ...settings, ...patch };
      for (const l of listeners) l(settings, Object.keys(patch) as (keyof Settings)[]);
    },
    system: () => system,
  };
}

describe('login item reconcile', () => {
  it('does nothing when the OS and the stored setting agree', () => {
    const h = harness({ system: true, stored: true });
    reconcileLoginItem(h.deps);
    expect(h.writeSettings).not.toHaveBeenCalled();
  });

  it('the OS wins on boot: a login item removed in System Settings is written back', () => {
    const h = harness({ system: false, stored: true });
    reconcileLoginItem(h.deps);
    expect(h.writeSettings).toHaveBeenCalledWith({ startAtLogin: false });
    expect(h.setOpenAtLogin).not.toHaveBeenCalled();
  });

  it('the OS wins the other way too', () => {
    const h = harness({ system: true, stored: false });
    reconcileLoginItem(h.deps);
    expect(h.writeSettings).toHaveBeenCalledWith({ startAtLogin: true });
  });
});

describe('installLoginItem', () => {
  it('pushes a user change through to the OS', () => {
    const h = harness({ system: false, stored: false });
    installLoginItem(h.deps);
    h.change({ startAtLogin: true });
    expect(h.setOpenAtLogin).toHaveBeenCalledWith(true);
    expect(h.system()).toBe(true);
  });

  it('ignores unrelated settings changes and no-op writes', () => {
    const h = harness({ system: true, stored: true });
    installLoginItem(h.deps);
    h.change({ theme: 'dark' });
    h.change({ startAtLogin: true });
    expect(h.setOpenAtLogin).not.toHaveBeenCalled();
  });

  it('stops listening after dispose', () => {
    const h = harness({ system: false, stored: false });
    installLoginItem(h.deps)();
    h.change({ startAtLogin: true });
    expect(h.setOpenAtLogin).not.toHaveBeenCalled();
  });
});
