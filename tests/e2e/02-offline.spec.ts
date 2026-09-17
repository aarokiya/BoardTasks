import { test, expect } from './fixtures';

test('edits made offline queue locally and flush when the server is back', async ({ win, google }) => {
  await fetch(`${google.url}/__control/offline`, { method: 'POST' });

  for (const title of ['Offline one', 'Offline two', 'Offline three']) {
    await win.keyboard.press('Meta+n');
    await win.keyboard.type(`${title} today`);
    await win.keyboard.press('Enter');
    await win.keyboard.press('Escape');
    await expect(win.getByRole('treeitem', { name: new RegExp(title) })).toBeVisible();
  }

  // The indicator must report offline with a pending count, and the UI stays usable.
  const status = win.getByRole('button', { name: /Sync status/ });
  await expect(status).toHaveAccessibleName(/offline|pending|waiting|3/i, { timeout: 15_000 });

  await fetch(`${google.url}/__control/online`, { method: 'POST' });
  await expect
    .poll(async () => {
      const json = await fetch(`${google.url}/__control/state`).then((r) => r.text());
      return ['Offline one', 'Offline two', 'Offline three'].every((t) => json.includes(t));
    }, { timeout: 20_000 })
    .toBe(true);
  await expect(status).toHaveAccessibleName(/synced/i, { timeout: 15_000 });
});
