import { z } from 'zod';
import { DEFAULT_SETTINGS, type Settings } from '@shared/models';
import { getDb } from '../connection';
import { nowIso } from '../../util/time';

export const settingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  density: z.enum(['compact', 'default', 'comfortable']),
  translucentSidebar: z.boolean(),
  startAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  showTrayIcon: z.boolean(),
  dockBadgeMode: z.enum(['today', 'overdue', 'both', 'off']),
  quickAddShortcut: z.string().min(1).max(64),
  notificationsEnabled: z.boolean(),
  notificationLeadMinutes: z.number().int().min(0).max(1440),
  dateOnlyReminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  defaultListId: z.string().max(128).nullable(),
  syncIntervalSec: z.number().int().min(15).max(3600),
  dateOrder: z.enum(['MDY', 'DMY']),
  onboardingComplete: z.boolean(),
  closeToTrayExplained: z.boolean(),
  showCompletedInLists: z.boolean(),
});
export const settingsPatchSchema = settingsSchema.partial();

type Listener = (s: Settings, changed: (keyof Settings)[]) => void;
const listeners = new Set<Listener>();
let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const rows = getDb().prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[];
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      merged[r.key] = JSON.parse(r.value_json) as unknown;
    } catch {
      /* ignore corrupt row; default wins */
    }
  }
  const parsed = settingsSchema.safeParse(merged);
  cache = parsed.success ? parsed.data : { ...DEFAULT_SETTINGS, ...pickValid(merged) };
  return cache;
}

function pickValid(raw: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const single = settingsSchema.shape[k as keyof Settings];
    if (single && single.safeParse(v).success) out[k] = v;
  }
  return out;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at');
  const now = nowIso();
  const before = getSettings();
  const changed: (keyof Settings)[] = [];
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (JSON.stringify(before[k as keyof Settings]) !== JSON.stringify(v)) changed.push(k as keyof Settings);
      stmt.run(k, JSON.stringify(v), now);
    }
  })();
  cache = null;
  const after = getSettings();
  if (changed.length) for (const l of listeners) l(after, changed);
  return after;
}

export function onSettingsChanged(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function resetSettingsCache(): void {
  cache = null;
}
