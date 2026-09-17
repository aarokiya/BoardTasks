import { test, expect } from './fixtures';

test.describe('smoke', () => {
  test('launches, renders the shell, creates a task via inline quick add, and pushes it to Google', async ({ win, google }) => {
    await expect(win.locator('[data-bt-shell]')).toBeVisible();
    await win.screenshot({ path: 'test-results/shots/01-shell.png' });

    await win.keyboard.press('Meta+n');
    const input = win.locator('[data-bt-shell] input[type="text"], [data-bt-shell] textarea').first();
    await expect(input).toBeFocused();
    await win.keyboard.type('Ship release notes tomorrow 5pm !1');
    await win.screenshot({ path: 'test-results/shots/02-quickadd.png' });
    await win.keyboard.press('Enter');
    await win.keyboard.press('Escape');

    await expect(win.getByRole('treeitem', { name: /Upcoming, 1 task/ })).toBeVisible({ timeout: 5_000 });
    await win.keyboard.press('Meta+2');
    await expect(win.getByRole('treeitem', { name: /Ship release notes/ })).toBeVisible();
    await win.screenshot({ path: 'test-results/shots/03-upcoming.png' });

    // The outbox should flush to the fake server within a few seconds.
    await expect
      .poll(async () => {
        const res = await fetch(`${google.url}/__control/state`);
        const json = (await res.json()) as { tasks?: Record<string, unknown[]> } & Record<string, unknown>;
        return JSON.stringify(json).includes('Ship release notes');
      }, { timeout: 10_000 })
      .toBe(true);

    await win.keyboard.press('Meta+k');
    await expect(win.getByRole('dialog')).toBeVisible();
    await win.screenshot({ path: 'test-results/shots/04-palette.png' });
    await win.keyboard.press('Escape');
  });
});
