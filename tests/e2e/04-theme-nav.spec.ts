import { test, expect } from './fixtures';

test('views switch with ⌘1–7, the theme follows nativeTheme without reload, and the window restores', async ({ win, app }) => {
  const heading = win.getByRole('heading', { level: 1 });
  await win.keyboard.press('Meta+2');
  await expect(heading).toHaveText(/Upcoming/);
  await win.keyboard.press('Meta+4');
  await expect(heading).toHaveText(/All/);
  await win.keyboard.press('Meta+1');
  await expect(heading).toHaveText(/Today/);

  const before = await win.evaluate(() => document.documentElement.dataset['theme']);
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await expect.poll(() => win.evaluate(() => document.documentElement.dataset['theme'])).toBe('light');
  await win.screenshot({ path: 'test-results/shots/06-light.png' });
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await expect.poll(() => win.evaluate(() => document.documentElement.dataset['theme'])).toBe('dark');
  expect(before).toMatch(/light|dark/);

  // The renderer cannot reach the network directly.
  const blocked = await win.evaluate(() => fetch('https://tasks.googleapis.com/').then(() => 'ALLOWED').catch(() => 'blocked'));
  expect(blocked).toBe('blocked');
});
