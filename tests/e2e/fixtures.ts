import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGoogle } from '../fixtures/fakeGoogle';

type FakeGoogle = Awaited<ReturnType<typeof startFakeGoogle>>;

export interface E2EFixtures {
  google: FakeGoogle;
  userData: string;
  app: ElectronApplication;
  win: Page;
  /** Relaunch the app against the same profile + fake server (for persistence tests). */
  relaunch: () => Promise<{ app: ElectronApplication; win: Page }>;
}

export const FAKE_AUTH = JSON.stringify({
  clientId: '123-fake.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-fake',
  accessToken: 'ya29.e2e-access',
  refreshToken: '1//e2e-refresh',
  expiresIn: 3600,
});

export async function launch(userData: string, googleUrl: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js')],
    env: {
      ...process.env,
      BT_E2E: '1',
      BT_USER_DATA: userData,
      BT_GOOGLE_BASE_URL: googleUrl,
      BT_FAKE_AUTH: FAKE_AUTH,
      BT_SKIP_ONBOARDING: '1',
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('[data-bt-shell]', { timeout: 20_000 });
  return { app, win };
}

/** Quit through app.quit() (the real ⌘Q path), then let Playwright reap the process. */
export async function quitApp(app: ElectronApplication): Promise<void> {
  let proc: ReturnType<ElectronApplication['process']>;
  try {
    proc = app.process();
  } catch {
    return; // already closed
  }
  if (proc.exitCode !== null) return;
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); }).catch(() => {});
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 8000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  await app.close().catch(() => {});
}

export const test = base.extend<E2EFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the destructured object
  google: async ({}, use) => {
    const g = await startFakeGoogle();
    await use(g);
    await g.stop();
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the destructured object
  userData: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'bt-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ userData, google }, use) => {
    const { app } = await launch(userData, google.url);
    await use(app);
    await quitApp(app);
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await use(win);
  },
  relaunch: async ({ userData, google }, use) => {
    await use(() => launch(userData, google.url));
  },
});

export const expect = test.expect;
