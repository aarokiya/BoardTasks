import { test, expect } from './fixtures';

test('a permanently failing change parks in the outbox and can be retried', async ({ win, google }) => {
  // Make every task insert fail with a 400 (permanent) a few times.
  await fetch(`${google.url}/__control/fail-next`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'POST', path: '/tasks', status: 400, times: 1 }) });
  await win.keyboard.press('Meta+n');
  await win.keyboard.type('Doomed task today');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Escape');
  await expect(win.getByRole('treeitem', { name: /Doomed task/ })).toBeVisible();

  const status = win.getByRole('button', { name: /Sync status/ });
  await expect(status).toHaveAccessibleName(/fail|error|didn.t sync|parked/i, { timeout: 20_000 });

  // Review sheet lists it with a human error and a Retry action.
  await win.keyboard.press('Meta+k');
  await win.keyboard.type('unsynced');
  await win.keyboard.press('Enter');
  const sheet = win.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/Doomed task/)).toBeVisible();
  await win.screenshot({ path: 'test-results/shots/05-outbox.png' });
  await sheet.getByRole('button', { name: /^Retry$/ }).first().click();

  await expect
    .poll(async () => (await fetch(`${google.url}/__control/state`).then((r) => r.text())).includes('Doomed task'), { timeout: 15_000 })
    .toBe(true);
});
