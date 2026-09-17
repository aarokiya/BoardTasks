import { app, shell } from 'electron';
import { z } from 'zod';
import type { Routes } from '../router';
import { AppError } from '../errors';
import { openExternalChecked } from '../../security/harden';
import { getLogPath } from '../../logger';
import { isE2E } from '../../env';
import { urlSchema, voidSchema } from '../schemas';
import { getSettings } from '../../db/repositories/settings';
import { getMainWindow, bootArgs } from '../../windows/main-window';

type AppRoutes = Pick<Routes, 'app:getInfo' | 'app:getBootstrap' | 'app:openExternal' | 'app:revealLogs' | 'app:setZoom'>;

export function appRoutes(): AppRoutes {
  return {
    'app:getInfo': {
      schema: voidSchema,
      handle: () => ({
        version: __APP_VERSION__,
        electron: process.versions.electron ?? '',
        platform: process.platform,
        isPackaged: app.isPackaged,
        userDataPath: app.getPath('userData'),
        logPath: getLogPath() ?? '',
        e2e: isE2E,
      }),
    },
    'app:getBootstrap': {
      schema: voidSchema,
      handle: (_p, ev) => {
        const args = bootArgs(ev.sender.id === getMainWindow()?.webContents.id ? 'main' : 'quickadd', getSettings().theme);
        const get = (k: string): string => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? '';
        return {
          window: get('bt-window') as 'main' | 'quickadd',
          theme: get('bt-theme') as 'light' | 'dark',
          themePreference: get('bt-theme-pref') as 'light' | 'dark' | 'system',
          platform: process.platform,
        };
      },
    },
    'app:openExternal': {
      schema: z.object({ url: urlSchema }),
      handle: ({ url }) => {
        if (!openExternalChecked(url)) throw new AppError('FORBIDDEN', 'That link is not on the allowlist.');
      },
    },
    'app:revealLogs': {
      schema: voidSchema,
      handle: () => {
        const p = getLogPath();
        if (p) shell.showItemInFolder(p);
      },
    },
    'app:setZoom': {
      schema: z.union([z.object({ delta: z.number().min(-5).max(5) }), z.object({ reset: z.literal(true) })]),
      handle: (p, ev) => {
        const wc = ev.sender;
        const next = 'reset' in p ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + p.delta));
        wc.setZoomLevel(next);
        return next;
      },
    },
  };
}
