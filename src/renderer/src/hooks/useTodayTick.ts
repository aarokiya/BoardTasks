import { useEffect } from 'react';
import { useStore } from '../store/store';

function msUntilNextMidnight(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

/** Keeps `today` correct across midnight, sleep/wake, focus, and visibility changes. */
export function useTodayTick(): void {
  const refresh = useStore((s) => s.refreshToday);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => {
        refresh();
        arm();
      }, Math.min(msUntilNextMidnight(), 2 ** 31 - 1));
    };
    arm();
    const onVis = (): void => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);
}
