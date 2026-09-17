import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../../../../src/shared/ipc';
import { CHANNELS } from '../../../../src/shared/ipc';

interface Bridge {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  onEvent: (cb: (e: unknown) => void) => () => void;
  boot: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  exposed: [] as Array<{ key: string; api: unknown }>,
  invoked: [] as Array<{ channel: string; payload: unknown }>,
  listeners: [] as Array<{ channel: string; fn: unknown }>,
  removed: [] as Array<{ channel: string; fn: unknown }>,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown): void => {
      h.exposed.push({ key, api });
    },
  },
  ipcRenderer: {
    invoke: (channel: string, payload: unknown): Promise<unknown> => {
      h.invoked.push({ channel, payload });
      return Promise.resolve({ ok: true, data: null });
    },
    on: (channel: string, fn: unknown): void => {
      h.listeners.push({ channel, fn });
    },
    removeListener: (channel: string, fn: unknown): void => {
      h.removed.push({ channel, fn });
    },
  },
}));

async function load(argv: string[] = []): Promise<Bridge> {
  const saved = process.argv;
  process.argv = ['electron', 'app', ...argv];
  try {
    h.exposed = [];
    vi.resetModules();
    await import('../../../../src/preload/index');
  } finally {
    process.argv = saved;
  }
  const entry = h.exposed.at(-1);
  expect(entry?.key).toBe('boardtasks');
  return entry?.api as Bridge;
}

beforeEach(() => {
  h.invoked = [];
  h.listeners = [];
  h.removed = [];
});

describe('preload bridge surface', () => {
  it('exposes exactly invoke, onEvent and boot', async () => {
    const api = await load();
    expect(Object.keys(api).sort()).toEqual(['boot', 'invoke', 'onEvent']);
  });

  it('leaks no node capability through boot', async () => {
    const api = await load(['--bt-window=quickadd', '--bt-theme=dark', '--bt-e2e=1']);
    expect(Object.keys(api.boot).sort()).toEqual(['e2e', 'platform', 'theme', 'themePreference', 'window']);
    for (const [k, v] of Object.entries(api.boot)) {
      expect(typeof v, `boot.${k}`).not.toBe('function');
      expect(typeof v, `boot.${k}`).not.toBe('object');
    }
    // A string copy of process.platform, not process itself.
    expect(typeof api.boot['platform']).toBe('string');
    expect(api.boot['window']).toBe('quickadd');
    expect(api.boot['theme']).toBe('dark');
    expect(api.boot['e2e']).toBe(true);
  });

  it('defaults boot values when the window was launched without arguments', async () => {
    const api = await load();
    expect(api.boot['window']).toBe('main');
    expect(api.boot['theme']).toBe('light');
    expect(api.boot['e2e']).toBe(false);
  });
});

describe('preload channel allowlist', () => {
  it('forwards a declared channel', async () => {
    const api = await load();
    await api.invoke('tasks:getAll');
    expect(h.invoked).toEqual([{ channel: 'tasks:getAll', payload: null }]);
  });

  it.each([
    'ipc-message',
    'ELECTRON_BROWSER_REQUIRE',
    '__electron__',
    'tasks:getAll ',
    'tasks:deleteEverything',
    '',
  ])('refuses the undeclared channel %o without touching ipcRenderer', async (channel) => {
    const api = await load();
    await expect(api.invoke(channel)).rejects.toThrow(/Blocked IPC channel/);
    expect(h.invoked).toEqual([]);
  });

  it('accepts every channel in the contract and nothing else', async () => {
    const api = await load();
    for (const channel of CHANNELS satisfies readonly Channel[]) {
      await expect(api.invoke(channel)).resolves.toBeDefined();
    }
    expect(h.invoked).toHaveLength(CHANNELS.length);
  });

  it('subscribes to the single event channel and unsubscribes cleanly', async () => {
    const api = await load();
    const off = api.onEvent(() => undefined);
    expect(h.listeners).toHaveLength(1);
    expect(h.listeners[0]?.channel).toBe('bt:event');
    off();
    expect(h.removed).toHaveLength(1);
    expect(h.removed[0]?.fn).toBe(h.listeners[0]?.fn);
  });
});
