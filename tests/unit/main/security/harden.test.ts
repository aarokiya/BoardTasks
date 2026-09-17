import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Harden from '../../../../src/main/security/harden';

const h = vi.hoisted(() => ({ packaged: false, opened: [] as string[] }));

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
  shell: {
    openExternal: (url: string): Promise<void> => {
      h.opened.push(url);
      return Promise.resolve();
    },
  },
}));

async function load(): Promise<typeof Harden> {
  vi.resetModules();
  return import('../../../../src/main/security/harden');
}

beforeEach(() => {
  h.opened = [];
  h.packaged = false;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openExternalChecked', () => {
  it('opens an allowlisted https host', async () => {
    const { openExternalChecked } = await load();
    expect(openExternalChecked('https://github.com/o/r/issues/12')).toBe(true);
    expect(h.opened).toEqual(['https://github.com/o/r/issues/12']);
  });

  it.each([
    ['a host that is not on the allowlist', 'https://evil.example/x'],
    ['a lookalike subdomain', 'https://github.com.evil.example/x'],
    ['plain http, even to an allowlisted host', 'http://github.com/o/r'],
    ['file://', 'file:///etc/passwd'],
    ['javascript:', 'javascript:alert(1)'],
    ['a macOS settings deep link', 'x-apple.systempreferences:com.apple.Whatever'],
    ['our own app scheme', 'app://boardtasks/index.html'],
    ['garbage', 'not a url at all'],
    ['an empty string', ''],
  ])('refuses %s', async (_label, url) => {
    const { openExternalChecked } = await load();
    expect(openExternalChecked(url)).toBe(false);
    expect(h.opened).toEqual([]);
  });

  it('does not log the query string of a rejected url', async () => {
    const { openExternalChecked } = await load();
    const warn = vi.mocked(console.warn);
    openExternalChecked('https://evil.example/collect?access_token=ya29.SuperSecretValue123456');
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('evil.example');
    expect(logged).not.toContain('ya29.SuperSecretValue123456');
  });
});

describe('isInternalUrl', () => {
  it('accepts our own origin', async () => {
    const { isInternalUrl } = await load();
    expect(isInternalUrl('app://boardtasks/index.html')).toBe(true);
    expect(isInternalUrl('app://boardtasks/index.html#quickadd')).toBe(true);
  });

  it('rejects another host on our own scheme', async () => {
    const { isInternalUrl } = await load();
    expect(isInternalUrl('app://evil/index.html')).toBe(false);
  });

  it('rejects remote and local-file origins', async () => {
    const { isInternalUrl } = await load();
    expect(isInternalUrl('https://evil.example')).toBe(false);
    expect(isInternalUrl('file:///Applications')).toBe(false);
    expect(isInternalUrl('')).toBe(false);
  });

  it('trusts the Vite dev origin only in a development build', async () => {
    h.packaged = false;
    const dev = await load();
    expect(dev.isInternalUrl('http://127.0.0.1:5173/')).toBe(true);

    // Packaged: 127.0.0.1:5173 is a port any local process can bind. Treating
    // it as ourselves would let a renderer navigate there and inherit IPC.
    h.packaged = true;
    const packaged = await load();
    expect(packaged.isInternalUrl('http://127.0.0.1:5173/')).toBe(false);
    expect(packaged.internalOrigins()).toEqual(['app://boardtasks']);
  });
});
