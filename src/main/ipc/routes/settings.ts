import type { Routes } from '../router';
import { getSettings, setSettings, settingsPatchSchema } from '../../db/repositories/settings';
import { voidSchema } from '../schemas';
import { emit } from '../emitter';

type SettingsRoutes = Pick<Routes, 'settings:getAll' | 'settings:set'>;

export function settingsRoutes(): SettingsRoutes {
  return {
    'settings:getAll': { schema: voidSchema, handle: () => getSettings() },
    'settings:set': {
      schema: settingsPatchSchema,
      handle: (patch) => {
        const s = setSettings(patch);
        emit({ type: 'settings:changed', settings: s });
        return s;
      },
    },
  };
}
