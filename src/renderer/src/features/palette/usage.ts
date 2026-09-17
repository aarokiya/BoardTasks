/**
 * Palette memory: which commands you actually use, and which tasks you opened
 * last. Kept in localStorage — losing it is a non-event, so every access is
 * wrapped and failures are silent (private mode, cleared site data, E2E).
 */
const USAGE_KEY = 'bt.palette.usage.v1';
const RECENT_KEY = 'bt.palette.recent.v1';
const RECENT_MAX = 5;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function commandUsage(): Record<string, number> {
  const raw = readJson<Record<string, unknown>>(USAGE_KEY, {});
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

export function bumpCommandUsage(id: string): void {
  const usage = commandUsage();
  usage[id] = (usage[id] ?? 0) + 1;
  writeJson(USAGE_KEY, usage);
}

export function recentTaskIds(): string[] {
  const raw = readJson<unknown>(RECENT_KEY, []);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
}

export function pushRecentTask(id: string): void {
  const next = [id, ...recentTaskIds().filter((x) => x !== id)].slice(0, RECENT_MAX);
  writeJson(RECENT_KEY, next);
}

export function clearPaletteMemory(): void {
  try {
    localStorage.removeItem(USAGE_KEY);
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* ignore */
  }
}
