import { app } from 'electron';

/**
 * Test and E2E seams, and the one place they are allowed to exist.
 *
 * Every variable below is an instruction to trust something else: a different
 * token endpoint, a different GitHub API, a fabricated credential set, a
 * different profile directory. A user can be talked into launching an app with
 * an environment variable set ("paste this into Terminal to fix syncing"), so
 * in a packaged build they are not merely ignored — they are deleted from
 * `process.env` at module load, before any other module can read one directly.
 *
 * This module is imported from bootstrap() at the top of startup, so the delete
 * happens before the first network call can be configured.
 */
const OVERRIDE_VARS = [
  'BT_E2E',
  'BT_GOOGLE_BASE_URL',
  'BT_GITHUB_BASE_URL',
  'BT_FAKE_AUTH',
  'BT_USER_DATA',
  'BT_SKIP_ONBOARDING',
] as const;

type OverrideVar = (typeof OVERRIDE_VARS)[number];

/** Overrides exist only in a development / test build. Packaged means production, always. */
export const overridesAllowed = !app.isPackaged;

if (!overridesAllowed) {
  for (const name of OVERRIDE_VARS) delete process.env[name];
}

function override(name: OverrideVar): string | null {
  if (!overridesAllowed) return null;
  return process.env[name] ?? null;
}

export const isE2E = override('BT_E2E') === '1';
export const isDev = !app.isPackaged && !isE2E;
export const googleBaseUrl = override('BT_GOOGLE_BASE_URL');
export const githubBaseUrl = override('BT_GITHUB_BASE_URL');
export const fakeAuthJson = override('BT_FAKE_AUTH');
export const userDataOverride = override('BT_USER_DATA');
export const skipOnboarding = override('BT_SKIP_ONBOARDING') === '1';
