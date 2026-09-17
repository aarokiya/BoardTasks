import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Env from '../../../../src/main/env';

const h = vi.hoisted(() => ({ packaged: false }));

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return h.packaged;
    },
  },
}));

const SEAMS = ['BT_E2E', 'BT_GOOGLE_BASE_URL', 'BT_GITHUB_BASE_URL', 'BT_FAKE_AUTH', 'BT_USER_DATA', 'BT_SKIP_ONBOARDING'] as const;

const saved = new Map<string, string | undefined>();

function setAll(): void {
  process.env['BT_E2E'] = '1';
  process.env['BT_GOOGLE_BASE_URL'] = 'http://attacker.example';
  process.env['BT_GITHUB_BASE_URL'] = 'http://attacker.example/gh';
  process.env['BT_FAKE_AUTH'] = JSON.stringify({ accessToken: 'a', refreshToken: 'r' });
  process.env['BT_USER_DATA'] = '/tmp/attacker-profile';
  process.env['BT_SKIP_ONBOARDING'] = '1';
}

async function load(): Promise<typeof Env> {
  vi.resetModules();
  return import('../../../../src/main/env');
}

beforeEach(() => {
  for (const k of SEAMS) saved.set(k, process.env[k]);
});

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  h.packaged = false;
});

describe('env seams in a development build', () => {
  it('honours every override', async () => {
    h.packaged = false;
    setAll();
    const env = await load();
    expect(env.overridesAllowed).toBe(true);
    expect(env.isE2E).toBe(true);
    expect(env.googleBaseUrl).toBe('http://attacker.example');
    expect(env.githubBaseUrl).toBe('http://attacker.example/gh');
    expect(env.fakeAuthJson).not.toBeNull();
    expect(env.userDataOverride).toBe('/tmp/attacker-profile');
    expect(env.skipOnboarding).toBe(true);
  });
});

describe('env seams in a packaged build', () => {
  /**
   * The threat is a user talked into `BT_GOOGLE_BASE_URL=... open -a BoardTasks`
   * — which would point the token exchange at an attacker and hand over a
   * refresh token. Packaged means production: no seam, no exception.
   */
  it('ignores every override', async () => {
    h.packaged = true;
    setAll();
    const env = await load();
    expect(env.overridesAllowed).toBe(false);
    expect(env.isE2E).toBe(false);
    expect(env.isDev).toBe(false);
    expect(env.googleBaseUrl).toBeNull();
    expect(env.githubBaseUrl).toBeNull();
    expect(env.fakeAuthJson).toBeNull();
    expect(env.userDataOverride).toBeNull();
    expect(env.skipOnboarding).toBe(false);
  });

  it('deletes the variables from process.env so a direct reader cannot see them either', async () => {
    h.packaged = true;
    setAll();
    await load();
    for (const k of SEAMS) expect(process.env[k], k).toBeUndefined();
  });
});
