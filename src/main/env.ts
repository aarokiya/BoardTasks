import { app } from 'electron';

export const isE2E = process.env['BT_E2E'] === '1';
export const isDev = !app.isPackaged && !isE2E;
export const googleBaseUrl = process.env['BT_GOOGLE_BASE_URL'] ?? null;
export const githubBaseUrl = process.env['BT_GITHUB_BASE_URL'] ?? null;
export const fakeAuthJson = process.env['BT_FAKE_AUTH'] ?? null;
export const userDataOverride = process.env['BT_USER_DATA'] ?? null;
