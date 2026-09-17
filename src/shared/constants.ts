export const APP_ID = 'app.boardtasks.desktop';
export const APP_NAME = 'BoardTasks';
export const APP_SCHEME = 'app';
export const APP_HOST = 'boardtasks';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const ASSET_SCHEME = 'bt-asset';
export const DEV_SERVER_ORIGIN = 'http://127.0.0.1:5173';
export const URL_SCHEME = 'boardtasks';

export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_TASKS_BASE_URL = 'https://tasks.googleapis.com/tasks/v1';
export const GITHUB_API_BASE_URL = 'https://api.github.com';

export const LIMITS = {
  taskTitle: 1024,
  taskNotes: 8192,
  listTitle: 1024,
  tasksPerList: 20_000,
  maxNesting: 1,
} as const;

/** Hosts the app is allowed to open in the system browser. */
export const EXTERNAL_HOST_ALLOWLIST = [
  'accounts.google.com',
  'myaccount.google.com',
  'console.cloud.google.com',
  'tasks.google.com',
  'developers.google.com',
  'support.google.com',
  'github.com',
  'www.github.com',
  'docs.github.com',
] as const;

export const SMART_VIEWS = ['today', 'upcoming', 'overdue', 'all', 'nodate', 'github', 'completed'] as const;
export type SmartViewId = (typeof SMART_VIEWS)[number];
export type ViewId = SmartViewId | `list:${string}`;

export const ID_RE = /^[A-Za-z0-9_\-:.]{1,128}$/;
export const GOOGLE_CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** URL.origin is 'null' for non-special schemes (app://), so compute it by hand. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}
