import type { ThemePreference } from '@shared/models';
import { announce } from '../../lib/announce';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { applyTheme } from '../../hooks/useThemeSync';
import type { CommandId } from '../ids';
import type { CommandImpl } from '../registry';
import { targetIds, targetTasks } from './helpers';

const THEME_LABEL: Record<ThemePreference, string> = {
  light: 'Light appearance',
  dark: 'Dark appearance',
  system: 'Appearance follows the system',
};

function themeCommand(theme: ThemePreference): CommandImpl {
  return {
    run: async () => {
      await call('settings:set', { theme }).catch(() => null);
      // applyTheme is the ONE place that writes data-theme: it suppresses
      // transitions for a frame so nothing cross-fades through the wrong
      // colours. 'system' resolves in main and arrives as theme:changed.
      if (theme !== 'system') applyTheme(theme);
      announce(THEME_LABEL[theme]);
    },
  };
}

export const viewCommands: Partial<Record<CommandId, CommandImpl>> = {
  'view.palette': {
    run: () => {
      const s = useStore.getState();
      if (s.overlay === 'palette') s.closeOverlay();
      else s.openOverlay('palette');
    },
  },
  'view.shortcuts': {
    run: () => {
      const s = useStore.getState();
      if (s.overlay === 'shortcuts') s.closeOverlay();
      else s.openOverlay('shortcuts');
    },
  },
  'view.theme.light': themeCommand('light'),
  'view.theme.dark': themeCommand('dark'),
  'view.theme.system': themeCommand('system'),
  'view.zoomIn': { run: async () => void (await call('app:setZoom', { delta: 0.5 }).catch(() => 0)) },
  'view.zoomOut': { run: async () => void (await call('app:setZoom', { delta: -0.5 }).catch(() => 0)) },
  'view.zoomReset': { run: async () => void (await call('app:setZoom', { reset: true }).catch(() => 0)) },
};

export const syncCommands: Partial<Record<CommandId, CommandImpl>> = {
  'sync.now': {
    run: async () => {
      announce('Syncing');
      const state = await call('sync:now', {}).catch(() => null);
      if (state) useStore.setState({ sync: state, online: state.online });
    },
  },
  'sync.full': {
    run: async () => {
      announce('Full resync started');
      const state = await call('sync:now', { full: true }).catch(() => null);
      if (state) useStore.setState({ sync: state, online: state.online });
    },
  },
  'sync.outbox': {
    run: () => {
      useStore.getState().openOverlay('outbox');
    },
  },
};

export const githubCommands: Partial<Record<CommandId, CommandImpl>> = {
  'github.link': {
    enabled: (ctx) => targetTasks(ctx).length > 0,
    run: (ctx) => {
      const [taskId] = targetIds(ctx);
      if (taskId) useStore.getState().openOverlay('github-picker', { taskId });
    },
  },
  'github.unlink': {
    enabled: (ctx) => !!targetTasks(ctx)[0]?.github,
    run: async (ctx) => {
      const task = targetTasks(ctx)[0];
      const link = task?.github;
      if (!task || !link) return;
      await call('github:unlink', { taskId: task.id }).catch(() => undefined);
      useStore.getState().pushUndo({
        label: 'Remove GitHub link',
        undo: async () => void (await call('github:link', { taskId: task.id, url: link.url }).catch(() => null)),
        redo: async () => void (await call('github:unlink', { taskId: task.id }).catch(() => undefined)),
      });
      announce('GitHub link removed');
    },
  },
  'github.open': {
    enabled: (ctx) => !!targetTasks(ctx)[0]?.github?.url,
    run: async (ctx) => {
      const url = targetTasks(ctx)[0]?.github?.url;
      if (url) await call('app:openExternal', { url }).catch(() => undefined);
    },
  },
  'github.refresh': {
    run: async (ctx) => {
      const task = targetTasks(ctx)[0];
      const req = task?.github ? { taskId: task.id } : ({ all: true } as const);
      const links = await call('github:refresh', req).catch(() => null);
      announce(links ? 'GitHub status refreshed' : 'Could not refresh GitHub');
    },
  },
};

export const appCommands: Partial<Record<CommandId, CommandImpl>> = {
  'app.settings': {
    run: () => {
      useStore.getState().openOverlay('settings');
    },
  },
  'app.signOut': {
    run: () => {
      useStore.getState().openOverlay('settings', { section: 'sync', intent: 'signOut' });
      announce('Settings — sign out');
    },
  },
  'app.revealLogs': {
    run: async () => {
      await call('app:revealLogs').catch(() => undefined);
    },
  },
};
