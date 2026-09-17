import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  retries: process.env['CI'] ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', video: 'retain-on-failure' },
});
