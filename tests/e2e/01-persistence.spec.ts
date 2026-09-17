import { test, expect, quitApp } from './fixtures';

test('completing a task persists across restart and reaches the server', async ({ win, app, google, relaunch }) => {
  await win.keyboard.press('Meta+n');
  await win.keyboard.type('Persisted task today');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Escape');
  const row = win.getByRole('treeitem', { name: /Persisted task/ });
  await expect(row).toBeVisible();

  // Complete it via the checkbox; optimistic strike-through must be immediate.
  const checkbox = row.getByRole('checkbox');
  await checkbox.click();
  await expect(win.getByRole('treeitem', { name: /Persisted task/ })).toHaveCount(0, { timeout: 3000 });

  await expect
    .poll(async () => {
      const json = await fetch(`${google.url}/__control/state`).then((r) => r.text());
      return json.includes('Persisted task') && json.includes('"completed"');
    }, { timeout: 10_000 })
    .toBe(true);

  await quitApp(app);
  const next = await relaunch();
  await next.win.keyboard.press('Meta+7');
  await expect(next.win.getByRole('treeitem', { name: /Persisted task/ })).toBeVisible();
  await quitApp(next.app);
});
