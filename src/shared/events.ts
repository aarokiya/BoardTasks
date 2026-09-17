import type { AuthStatus, GithubLink, Settings, SyncState, Task, TaskList, ResolvedTheme, ThemePreference } from './models';

export const MAIN_EVENT_CHANNEL = 'bt:event' as const;

/**
 * Main → renderer push events. One channel, one discriminated union.
 * `data:changed` carries full entities (batched, 50ms coalesced) so the
 * renderer never needs a follow-up round trip.
 */
export type MainEvent =
  | { type: 'auth:changed'; status: AuthStatus }
  | { type: 'sync:state'; state: SyncState }
  | {
      type: 'data:changed';
      reason: 'local' | 'sync' | 'conflict' | 'github';
      tasks: Task[];
      lists: TaskList[];
      deletedTaskIds: string[];
      deletedListIds: string[];
    }
  | { type: 'github:linkChanged'; link: GithubLink }
  | { type: 'settings:changed'; settings: Settings }
  | { type: 'theme:changed'; resolved: ResolvedTheme; preference: ThemePreference }
  | { type: 'net:status'; online: boolean }
  | { type: 'shortcut'; command: string }
  | { type: 'focusTask'; taskId: string }
  | { type: 'navigate'; view: string }
  | { type: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; message: string; actionLabel?: string; actionCommand?: string }
  | { type: 'system:resume' }
  | { type: 'window:focus'; focused: boolean }
  | { type: 'quickadd:shown' };
