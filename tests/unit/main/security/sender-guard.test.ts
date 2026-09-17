import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type * as Guard from '../../../../src/main/ipc/sender-guard';

const h = vi.hoisted(() => ({ packaged: false }));

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return h.packaged;
    },
    on: () => undefined,
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      setDevicePermissionHandler: () => undefined,
    },
  },
  shell: { openExternal: (): Promise<void> => Promise.resolve() },
}));

/** Only the two fields the guard reads; everything else on the event is irrelevant. */
function event(frame: { url: string; parent: unknown } | null): IpcMainInvokeEvent {
  return { senderFrame: frame } as unknown as IpcMainInvokeEvent;
}

const topFrame = (url: string): { url: string; parent: null } => ({ url, parent: null });

async function load(): Promise<typeof Guard> {
  vi.resetModules();
  return import('../../../../src/main/ipc/sender-guard');
}

beforeEach(() => {
  h.packaged = false;
});

describe('isTrustedSender', () => {
  it('accepts the top frame of our own origin', async () => {
    const { isTrustedSender } = await load();
    expect(isTrustedSender(event(topFrame('app://boardtasks/index.html')))).toBe(true);
    expect(isTrustedSender(event(topFrame('app://boardtasks/index.html#quickadd')))).toBe(true);
  });

  it('rejects a subframe even at our own origin', async () => {
    const { isTrustedSender } = await load();
    const sub = { url: 'app://boardtasks/index.html', parent: topFrame('app://boardtasks/index.html') };
    expect(isTrustedSender(event(sub))).toBe(false);
  });

  it('rejects an event whose frame has already gone away', async () => {
    const { isTrustedSender } = await load();
    expect(isTrustedSender(event(null))).toBe(false);
  });

  it.each([
    'https://evil.example/',
    'http://boardtasks/',
    'app://evil/index.html',
    'file:///Users/someone/index.html',
    'about:blank',
    '',
  ])('rejects a frame at %s', async (url) => {
    const { isTrustedSender } = await load();
    expect(isTrustedSender(event(topFrame(url)))).toBe(false);
  });

  it('trusts the Vite dev origin only in a development build', async () => {
    h.packaged = false;
    const dev = await load();
    expect(dev.isTrustedSender(event(topFrame('http://127.0.0.1:5173/')))).toBe(true);

    h.packaged = true;
    const packaged = await load();
    expect(packaged.isTrustedSender(event(topFrame('http://127.0.0.1:5173/')))).toBe(false);
  });
});
