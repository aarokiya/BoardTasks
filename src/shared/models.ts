import type { CivilDate } from './date/civil';

export type TaskStatus = 'needsAction' | 'completed';
/** 0 = none, 1 = high, 2 = medium, 3 = low. Local-only (Google has no priority). */
export type Priority = 0 | 1 | 2 | 3;
export type ListColor = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink';
export const LIST_COLORS: readonly ListColor[] = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];

export type SyncFlag = 'synced' | 'pending' | 'failed' | 'conflict';

export interface TaskLink {
  type: string;
  description: string;
  link: string;
}

export interface TaskConflict {
  /** Fields where both local and server changed since the common base. */
  fields: string[];
  /** The server's version of the conflicting fields. */
  server: Partial<Pick<Task, 'title' | 'notes' | 'status' | 'due'>>;
  /** True when the server deleted the task while we had local edits. */
  remoteDeleted: boolean;
  detectedAt: string;
}

export interface TaskList {
  /** Stable local UUID. Never changes. */
  id: string;
  /** Google tasklist id, null until first successful push. */
  remoteId: string | null;
  title: string;
  color: ListColor;
  /** Local sidebar order. */
  position: number;
  isDefault: boolean;
  sync: SyncFlag;
  rev: number;
  updatedAt: string | null;
}

export interface Task {
  /** Stable local UUID. Never changes, even after the server assigns a remote id. */
  id: string;
  remoteId: string | null;
  listId: string;
  title: string;
  notes: string;
  status: TaskStatus;
  /** Calendar date. Google discards time-of-day. */
  due: CivilDate | null;
  /** 'HH:mm', LOCAL ONLY — never sent to Google. Drives reminders. */
  dueTime: string | null;
  /** RFC3339 instant, from Google. */
  completedAt: string | null;
  /** Parent task local id. One level of nesting only. */
  parentId: string | null;
  /** Local sort key. Set from the server's opaque `position` on pull; fractional-indexed on local reorder. */
  sortKey: string;
  priority: Priority;
  flagged: boolean;
  hidden: boolean;
  deleted: boolean;
  webViewLink: string | null;
  links: TaskLink[];
  github: GithubLink | null;
  sync: SyncFlag;
  conflict: TaskConflict | null;
  /** Monotonic per-entity revision; the renderer drops pushes with rev <= current. */
  rev: number;
  createdAt: string;
  /** Server `updated`, null until synced. */
  updatedAt: string | null;
  localUpdatedAt: string;
}

export type GithubItemType = 'issue' | 'pull';
export type GithubState = 'open' | 'closed' | 'merged' | 'draft';
export type GithubChecks = 'success' | 'failure' | 'pending' | 'neutral';
export type GithubReview = 'approved' | 'changes_requested' | 'review_required';
export type GithubLinkError = 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'network' | 'no_token';

export interface GithubLink {
  id: string;
  taskId: string;
  url: string;
  host: string;
  owner: string;
  repo: string;
  type: GithubItemType;
  number: number;
  title: string | null;
  state: GithubState | null;
  author: string | null;
  authorAvatarUrl: string | null;
  labels: Array<{ name: string; color: string }>;
  checks: GithubChecks | null;
  reviewDecision: GithubReview | null;
  remoteUpdatedAt: string | null;
  fetchedAt: string | null;
  error: GithubLinkError | null;
  createdAt: string;
}

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type Density = 'compact' | 'default' | 'comfortable';
export type DockBadgeMode = 'today' | 'overdue' | 'both' | 'off';

export interface Settings {
  theme: ThemePreference;
  density: Density;
  translucentSidebar: boolean;
  startAtLogin: boolean;
  closeToTray: boolean;
  showTrayIcon: boolean;
  dockBadgeMode: DockBadgeMode;
  /** Electron accelerator string. */
  quickAddShortcut: string;
  notificationsEnabled: boolean;
  /** Minutes before dueTime to notify. 0 = at the time. */
  notificationLeadMinutes: number;
  /** For tasks with a due date but no time, notify at this time. null = don't. */
  dateOnlyReminderTime: string | null;
  defaultListId: string | null;
  syncIntervalSec: number;
  dateOrder: 'MDY' | 'DMY';
  onboardingComplete: boolean;
  closeToTrayExplained: boolean;
  showCompletedInLists: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  density: 'default',
  translucentSidebar: false,
  startAtLogin: false,
  closeToTray: true,
  showTrayIcon: true,
  dockBadgeMode: 'today',
  quickAddShortcut: 'Control+Shift+Space',
  notificationsEnabled: true,
  notificationLeadMinutes: 0,
  dateOnlyReminderTime: '09:00',
  defaultListId: null,
  syncIntervalSec: 60,
  dateOrder: 'MDY',
  onboardingComplete: false,
  closeToTrayExplained: false,
  showCompletedInLists: false,
};

export type AuthState =
  | 'no_credentials'
  | 'signed_out'
  | 'signing_in'
  | 'signed_in'
  | 'reauth_required'
  | 'keychain_unavailable';

export interface AuthStatus {
  state: AuthState;
  /** Last 12 chars of the client id, for the settings screen. Never the secret. */
  clientIdHint: string | null;
  account: { email: string | null; name: string | null } | null;
  /** Set when state === 'reauth_required'. */
  reason: 'invalid_grant' | 'revoked' | 'decrypt_failed' | 'expired_testing_mode' | null;
  signedInAt: string | null;
}

export type SyncStatusKind =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'rate_limited'
  | 'reauth_required'
  | 'paused'
  | 'captive_portal';

export interface SyncState {
  status: SyncStatusKind;
  online: boolean;
  lastSyncStartedAt: string | null;
  lastSyncSucceededAt: string | null;
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  errorMessage: string | null;
  retryAfterMs: number | null;
}

export type OutboxOp =
  | 'list.create' | 'list.update' | 'list.delete'
  | 'task.create' | 'task.update' | 'task.delete' | 'task.move' | 'task.clear';

export interface OutboxEntry {
  id: string;
  op: OutboxOp;
  entity: 'task' | 'list';
  entityId: string;
  /** Human-readable description: 'Rename "Book flights" → "Book flights to Lisbon"'. */
  description: string;
  status: 'pending' | 'inflight' | 'blocked' | 'parked' | 'done';
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  tokenHint: string | null;
  scopes: string[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  error: GithubLinkError | null;
}

export interface GithubSearchResult {
  url: string;
  owner: string;
  repo: string;
  type: GithubItemType;
  number: number;
  title: string;
  state: GithubState;
  author: string;
  updatedAt: string;
}

export interface AppInfo {
  version: string;
  electron: string;
  platform: string;
  isPackaged: boolean;
  userDataPath: string;
  logPath: string;
  e2e: boolean;
}

export interface WindowBootstrap {
  window: 'main' | 'quickadd';
  theme: ResolvedTheme;
  themePreference: ThemePreference;
  platform: string;
}

// ---- mutation inputs ----

/** Sibling to insert after (local id), null = first, 'end' = last. */
export type PreviousId = string | null;
export const PREVIOUS_END = 'end';

export interface TaskCreateInput {
  opId?: string;
  listId?: string;
  title: string;
  notes?: string;
  due?: CivilDate | null;
  dueTime?: string | null;
  parentId?: string | null;
  /** Insert after this sibling (local id). Omit/null = first. 'end' = last. */
  previousId?: PreviousId;
  priority?: Priority;
  flagged?: boolean;
  githubUrl?: string | null;
}

export interface TaskUpdateInput {
  opId?: string;
  id: string;
  patch: Partial<Pick<Task, 'title' | 'notes' | 'due' | 'dueTime' | 'priority' | 'flagged' | 'status'>>;
}

export interface TaskMoveInput {
  opId?: string;
  id: string;
  listId?: string;
  parentId: string | null;
  /** Local id of the sibling to place after; null = first; 'end' = last. */
  previousId: PreviousId;
}

export interface TaskQueryInput {
  q: string;
  limit?: number;
}
