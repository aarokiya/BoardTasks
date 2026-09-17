export const nowIso = (): string => new Date().toISOString();
export const isoPlusMs = (ms: number): string => new Date(Date.now() + ms).toISOString();
export const isoMinusMs = (iso: string, ms: number): string => new Date(Date.parse(iso) - ms).toISOString();

/** ms until next local midnight (+1s slack). */
export function msUntilNextMidnight(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

export const MAX_TIMER_MS = 2 ** 31 - 1;
