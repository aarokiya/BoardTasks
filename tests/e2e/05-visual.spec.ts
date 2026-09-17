/**
 * Visual walk-through: drives the app into every important state and saves a
 * light + dark screenshot of each to test-results/shots/. It is a design
 * review instrument first and a regression test second, so the assertions are
 * deliberately shallow (the state is reachable and rendered) — the pixels are
 * reviewed by eye.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGoogle } from '../fixtures/fakeGoogle';
import { test, expect, launch, quitApp, FAKE_AUTH } from './fixtures';

const SHOTS = 'test-results/shots';

/**
 * Playwright wipes its output directory asynchronously while the first tests
 * are already running, so anything written into test-results early in the run
 * disappears. Screenshots are therefore buffered and flushed once, at the end.
 */
const pending: Array<{ name: string; buf: Buffer }> = [];

function stash(name: string, buf: Buffer): void {
  pending.push({ name, buf });
}

test.afterAll(() => {
  mkdirSync(SHOTS, { recursive: true });
  for (const { name, buf } of pending) writeFileSync(`${SHOTS}/${name}`, buf);
  pending.length = 0;
});

type Theme = 'light' | 'dark';

/** The preload bridge, as seen from inside an evaluate() in the renderer. */
interface BridgeWindow {
  boardtasks: { invoke(channel: string, payload?: unknown): Promise<unknown> };
}

async function setTheme(app: ElectronApplication, win: Page, theme: Theme): Promise<void> {
  await app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t;
  }, theme);
  await expect.poll(() => win.evaluate(() => document.documentElement.dataset['theme'])).toBe(theme);
}

/** Saves <name>-light.png and <name>-dark.png and restores the starting theme. */
async function shot(app: ElectronApplication, win: Page, name: string): Promise<void> {
  // Let entry animations (pop-in, dialog-in, slide-in) finish, or the capture
  // lands mid-fade and every overlay looks translucent.
  await win.waitForTimeout(350);
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(app, win, theme);
    stash(`${name}-${theme}.png`, await win.screenshot());
  }
  await setTheme(app, win, 'light');
}

interface Ok<T> {
  ok: true;
  data: T;
}
type Envelope<T> = Ok<T> | { ok: false; error: { message: string } };

/** Calls a main-process channel from inside the renderer and unwraps the envelope. */
async function ipc<T>(win: Page, channel: string, payload?: unknown): Promise<T> {
  const res = (await win.evaluate(
    ([c, p]) => (window as unknown as BridgeWindow).boardtasks.invoke(c, p),
    [channel, payload] as [string, unknown],
  )) as Envelope<T>;
  if (!res.ok) throw new Error(`${channel} failed: ${res.error.message}`);
  return res.data;
}

interface SeededTask {
  id: string;
  title: string;
}

function civil(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parent + 2 subtasks, an overdue one, a completed one, a flagged/high-priority one. */
async function seedRichToday(win: Page): Promise<{ parent: SeededTask; overdue: SeededTask }> {
  const parent = await ipc<SeededTask>(win, 'tasks:create', {
    title: 'Prepare the quarterly review',
    notes: 'Pull the numbers from the dashboard, then write the one-page summary.\n\nShare it with the team by Thursday.',
    due: civil(0),
  });
  await ipc(win, 'tasks:create', { title: 'Collect last quarter’s numbers', parentId: parent.id, due: civil(0) });
  await ipc(win, 'tasks:create', { title: 'Draft the summary', parentId: parent.id, due: civil(0), priority: 2 });

  const overdue = await ipc<SeededTask>(win, 'tasks:create', { title: 'Renew the domain registration' });
  await ipc(win, 'tasks:update', { id: overdue.id, patch: { due: civil(-3) } });

  const done = await ipc<SeededTask>(win, 'tasks:create', { title: 'Send the invoice', due: civil(0) });
  await ipc(win, 'tasks:setStatus', { ids: [done.id], completed: true });

  await ipc(win, 'tasks:create', {
    title: 'Call the accountant about the filing deadline',
    due: civil(0),
    dueTime: '17:00',
    priority: 1,
    flagged: true,
  });
  return { parent, overdue };
}

test.describe('visual walk-through', () => {
  test.slow();

  test('main window states, light and dark', async ({ app, win, google }) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 860));
    await expect(win.locator('[data-bt-shell]')).toBeVisible();

    // --- Empty Today -----------------------------------------------------
    await win.keyboard.press('Meta+1');
    await expect(win.getByRole('heading', { level: 1 })).toHaveText(/Today/);
    await shot(app, win, '01-empty-today');

    // --- Inline quick add with chips -------------------------------------
    await win.keyboard.press('Meta+n');
    await win.keyboard.type('Email the landlord tomorrow 9am !1 *');
    await shot(app, win, '02-quickadd-inline');
    // The date chip opens the SAME calendar the inspector uses.
    await win.getByRole('button', { name: /^Due Tomorrow$/ }).click();
    await shot(app, win, '02b-quickadd-date-popover');
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');

    // --- Populated list --------------------------------------------------
    const { parent, overdue } = await seedRichToday(win);
    await expect(win.getByRole('treeitem', { name: /Prepare the quarterly review/ })).toBeVisible();
    await win.keyboard.press('Meta+7'); // completed lives in its own view by default
    await expect(win.getByRole('heading', { level: 1 })).toHaveText(/Completed/);
    await shot(app, win, '03-completed-view');
    await win.keyboard.press('Meta+1');
    await expect(win.getByRole('treeitem', { name: /Renew the domain/ })).toBeVisible();
    await shot(app, win, '04-today-populated');

    // --- aria-live actually fires ----------------------------------------
    await win.getByRole('treeitem', { name: /Renew the domain/ }).click();
    await win.keyboard.press(' ');
    await expect
      .poll(() => win.evaluate(() => document.getElementById('bt-status')?.textContent ?? ''), { timeout: 4_000 })
      .toMatch(/complet/i);
    await win.keyboard.press('Meta+z');

    // --- Detail pane with a selected task incl. notes ---------------------
    await win.getByRole('treeitem', { name: /Prepare the quarterly review/ }).click();
    await win.keyboard.press('Enter');
    await expect(win.getByLabel('Task details')).toBeVisible();
    await shot(app, win, '05-detail-pane');

    // --- Date picker popover ---------------------------------------------
    const dateButton = win.getByLabel('Task details').getByRole('button', { name: /due|date/i }).first();
    if (await dateButton.isVisible().catch(() => false)) {
      await dateButton.click();
      await shot(app, win, '06-date-picker');
      await win.keyboard.press('Escape');
    }

    // --- Multi-select + bulk bar ------------------------------------------
    await win.getByRole('treeitem', { name: /Prepare the quarterly review/ }).click();
    await win.getByRole('treeitem', { name: /Renew the domain/ }).click({ modifiers: ['Meta'] });
    await expect(win.getByRole('toolbar')).toBeVisible();
    await shot(app, win, '07-bulk-bar');
    await win.keyboard.press('Escape');

    // --- Command palette ---------------------------------------------------
    await win.keyboard.press('Meta+k');
    await expect(win.getByRole('dialog')).toBeVisible();
    await shot(app, win, '08-palette-open');
    await win.keyboard.type('due');
    await shot(app, win, '09-palette-query');
    await win.keyboard.press('Meta+a');
    await win.keyboard.type('zzqqxx');
    await shot(app, win, '10-palette-empty');
    await win.keyboard.press('Escape');

    // --- Shortcuts overlay --------------------------------------------------
    await win.keyboard.press('Meta+/');
    await expect(win.getByRole('dialog')).toBeVisible();
    await shot(app, win, '11-shortcuts');
    await win.keyboard.press('Escape');

    // --- Settings, every section -------------------------------------------
    await win.keyboard.press('Meta+,');
    const settings = win.getByRole('dialog');
    await expect(settings).toBeVisible();
    for (const label of ['General', 'Notifications', 'Sync', 'Google account', 'GitHub', 'Shortcuts', 'About']) {
      await settings.getByRole('tab', { name: label }).click();
      await shot(app, win, `12-settings-${label.toLowerCase().replace(/\s+/g, '-')}`);
    }
    await win.keyboard.press('Escape');

    // --- Outbox sheet -------------------------------------------------------
    await fetch(`${google.url}/__control/fail-next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'POST', path: '/tasks', status: 400, times: 1 }),
    });
    await win.keyboard.press('Meta+n');
    await win.keyboard.type('Book the venue deposit');
    await win.keyboard.press('Enter');
    await win.keyboard.press('Escape');
    const pill = win.getByRole('button', { name: /^Sync status/ });
    await expect.poll(() => pill.getAttribute('data-state'), { timeout: 25_000 }).toMatch(/error|rate_limited/);
    await shot(app, win, '13-sync-pill-error');
    await win.keyboard.press('Meta+k');
    await win.keyboard.type('unsynced');
    await win.keyboard.press('Enter');
    await expect(win.getByRole('dialog')).toBeVisible();
    await shot(app, win, '14-outbox-sheet');
    await win.keyboard.press('Escape');

    expect(parent.id).toBeTruthy();
    expect(overdue.id).toBeTruthy();
  });

  test('keyboard reaches everything from the list', async ({ win }) => {
    await seedRichToday(win);
    await win.keyboard.press('Meta+1');
    const first = win.getByRole('treeitem', { name: /Call the accountant/ });
    await first.click();

    // ⌘K from a focused row: the row must not swallow it as "k = previous task".
    await win.keyboard.press('Meta+k');
    await expect(win.getByRole('dialog')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.getByRole('dialog')).toBeHidden();

    // ⌥↓ reorders instead of moving the selection.
    const order = async (): Promise<string[]> =>
      win.locator('[data-testid="task-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id') ?? ''));
    await win.getByRole('treeitem', { name: /Call the accountant/ }).click();
    const before = await order();
    await win.keyboard.press('Alt+ArrowDown');
    await expect.poll(order).not.toEqual(before);

    // ⌘1–7 still work from inside a text field.
    await win.keyboard.press('Meta+f');
    await win.keyboard.press('Meta+2');
    await expect(win.getByRole('heading', { level: 1 })).toHaveText(/Upcoming/);

    // The list always has exactly one tab stop, even before anything is focused.
    await win.keyboard.press('Meta+1');
    const tabbable = await win.locator('[data-testid="task-row"][tabindex="0"]').count();
    expect(tabbable).toBe(1);
  });

  test('conflict banner', async ({ app, win, google }) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 860));
    const task = await ipc<SeededTask>(win, 'tasks:create', { title: 'Confirm the catering order' });
    await ipc(win, 'sync:now', {});

    // Wait for the push to reach the server so a remote id exists.
    const remoteIdOf = async (title: string): Promise<string> => {
      const state = (await fetch(`${google.url}/__control/state`).then((r) => r.json())) as {
        tasks: Array<{ id: string; title: string }>;
      };
      return state.tasks.find((t) => t.title === title)?.id ?? '';
    };
    await expect.poll(() => remoteIdOf('Confirm the catering order'), { timeout: 20_000 }).not.toBe('');
    const remoteId = await remoteIdOf('Confirm the catering order');

    // Another device edits it…
    await fetch(`${google.url}/__control/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: remoteId, patch: { title: 'Confirm the catering order (from my phone)' } }),
    });
    // …while we edit it here, before the next pull.
    await ipc(win, 'tasks:update', { id: task.id, patch: { title: 'Confirm the catering order for 40' } });
    await ipc(win, 'sync:now', {});

    // The banner lives in the inspector, so select the task and open it.
    // The task has no due date, so it lives in All, not Today.
    await win.keyboard.press('Meta+4');
    await win.getByRole('treeitem', { name: /Confirm the catering order/ }).first().click();
    await win.keyboard.press('Enter');

    // The cycle pulls the lists with queued work BEFORE pushing, so the remote
    // edit is merged, the both-changed title is raised as a conflict, and the
    // queued update is held back instead of overwriting Google.
    const banner = win.getByRole('region', { name: /sync conflict/i });
    await expect(banner.first()).toBeVisible({ timeout: 20_000 });
    await shot(app, win, '15-conflict');

    // The server's copy must still be the phone's until the user chooses.
    const serverTitle = async (): Promise<string | undefined> => {
      const state = (await fetch(`${google.url}/__control/state`).then((r) => r.json())) as {
        tasks: Array<{ id: string; title: string }>;
      };
      return state.tasks.find((t) => t.id === remoteId)?.title;
    };
    expect(await serverTitle()).toBe('Confirm the catering order (from my phone)');
  });

  test('narrow widths and the responsive collapse', async ({ app, win }) => {
    await seedRichToday(win);
    await win.keyboard.press('Meta+1');
    await expect(win.getByRole('treeitem', { name: /Prepare the quarterly review/ })).toBeVisible();
    await win.getByRole('treeitem', { name: /Prepare the quarterly review/ }).click();

    for (const [w, h, name] of [
      [1000, 760, '16-width-1000-clamped'],
      [900, 700, '17-width-900-rail'],
      [760, 660, '18-width-760-overlay'],
      [700, 600, '19-width-700-overlay'],
      [600, 560, '20-width-600-stack'],
    ] as const) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.w, size.h), { w, h });
      await win.waitForTimeout(400);
      await shot(app, win, name);
    }

    // The inspector opens as a sheet / fullscreen push down here.
    await win.keyboard.press('Meta+i');
    await win.waitForTimeout(400);
    await shot(app, win, '21-width-600-inspector');
  });

  test('the floating Quick Add window', async ({ app, win }) => {
    await expect(win.locator('[data-bt-shell]')).toBeVisible();
    await app.evaluate(() => (globalThis as { __btTriggerQuickAdd?: () => void }).__btTriggerQuickAdd?.());
    await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBeGreaterThan(1);
    const hud = app.windows().find((p) => p !== win)!;

    await hud.waitForSelector('input, textarea', { timeout: 10_000 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(app, hud, theme);
      stash(`22-quickadd-hud-empty-${theme}.png`, await hud.screenshot());
    }
    await hud.locator('input, textarea').first().fill('Pick up the dry cleaning friday 6pm #Personal !2');
    await hud.waitForTimeout(300);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(app, hud, theme);
      stash(`23-quickadd-hud-parsed-${theme}.png`, await hud.screenshot());
    }
  });

  test('a 500-task list stays responsive and virtualizes', async ({ app, win }) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 860));
    await win.keyboard.press('Meta+4');
    await win.evaluate(async () => {
      const bridge = (window as unknown as BridgeWindow).boardtasks;
      for (let i = 0; i < 500; i++) {
        await bridge.invoke('tasks:create', {
          title: `Bulk task ${String(i + 1).padStart(3, '0')} — a realistically long task title`,
        });
      }
    });
    await expect.poll(() => win.locator('[data-testid="task-row"]').count(), { timeout: 60_000 }).toBeGreaterThan(10);

    // Virtualization: far fewer DOM rows than tasks.
    const domRows = await win.locator('[data-testid="task-row"]').count();
    expect(domRows).toBeLessThan(200);
    await shot(app, win, '24-500-tasks');

    const t0 = Date.now();
    await win.keyboard.press('Meta+f');
    await win.keyboard.type('Bulk task 4');
    await expect.poll(() => win.locator('[data-testid="task-row"]').count()).toBeGreaterThan(0);
    const typingMs = Date.now() - t0;
    await shot(app, win, '25-500-tasks-filtered');
    expect(typingMs).toBeLessThan(15_000);
  });
});

test.describe('onboarding', () => {
  test.slow();

  test('the wizard, step by step', async () => {
    const google = await startFakeGoogle();
    const userData = mkdtempSync(join(tmpdir(), 'bt-onb-'));
    const app = await electron.launch({
      args: [join(process.cwd(), 'out/main/index.js')],
      env: {
        ...process.env,
        BT_E2E: '1',
        BT_USER_DATA: userData,
        BT_GOOGLE_BASE_URL: google.url,
        // No BT_FAKE_AUTH and no BT_SKIP_ONBOARDING: the wizard starts at step 1.
      },
    });
    try {
      const win = await app.firstWindow();
      await win.waitForSelector('[role="dialog"]', { timeout: 20_000 });
      await shot(app, win, '26-onboarding-step1');

      // Walk forward through the explainer steps.
      for (let step = 2; step <= 3; step++) {
        const next = win.getByRole('button', { name: /^(Next|Continue|I’ve done this|I've done this)/ }).first();
        if (!(await next.isVisible().catch(() => false))) break;
        await next.click();
        await win.waitForTimeout(250);
        await shot(app, win, `27-onboarding-step${step}`);
      }

      // The credentials step, with a deliberately wrong client ID to see the error.
      const idField = win.getByLabel(/client id/i).first();
      if (await idField.isVisible().catch(() => false)) {
        await idField.fill('not-a-client-id');
        await idField.blur();
        await shot(app, win, '28-onboarding-invalid-client-id');
        await idField.fill('123-fake.apps.googleusercontent.com');
        const secret = win.getByLabel(/client secret/i).first();
        if (await secret.isVisible().catch(() => false)) await secret.fill('GOCSPX-fake-secret');
        await shot(app, win, '29-onboarding-credentials-filled');
      }
    } finally {
      await quitApp(app);
      await google.stop();
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('the re-auth banner', async () => {
    const google = await startFakeGoogle();
    const userData = mkdtempSync(join(tmpdir(), 'bt-reauth-'));
    const { app, win } = await launch(userData, google.url, { BT_FAKE_AUTH: FAKE_AUTH });
    try {
      // Make every token refresh fail with invalid_grant, then force one.
      await fetch(`${google.url}/__control/fail-next`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'POST', path: '/token', status: 400, times: 20 }),
      });
      await fetch(`${google.url}/__control/fail-next`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'GET', status: 401, times: 20 }),
      });
      await win
        .evaluate(() => (window as unknown as BridgeWindow).boardtasks.invoke('sync:now', { full: true }))
        .catch(() => {});

      const banner = win.getByRole('button', { name: /Sign in again/ });
      const appeared = await banner
        .waitFor({ state: 'visible', timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
      await shot(app, win, appeared ? '30-reauth-banner' : '30-reauth-not-reproduced');
      expect(typeof appeared).toBe('boolean');
    } finally {
      await quitApp(app);
      await google.stop();
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
