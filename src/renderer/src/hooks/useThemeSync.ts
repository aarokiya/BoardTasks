import { useEffect } from 'react';
import type { ResolvedTheme } from '@shared/models';
import { onMainEvent } from '../lib/ipc';

/**
 * Theme changes bypass React entirely: the attribute is written straight onto
 * <html> with transitions suppressed for one frame, so nothing re-renders and
 * nothing cross-fades through the wrong colours.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  if (root.dataset.theme === resolved) return;
  root.classList.add('bt-theme-switching');
  root.dataset.theme = resolved;
  const clear = (): void => root.classList.remove('bt-theme-switching');
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(clear));
  else setTimeout(clear, 0);
}

export function useThemeSync(): void {
  useEffect(() => {
    const off = onMainEvent((e) => {
      if (e.type === 'theme:changed') applyTheme(e.resolved);
    });
    return off;
  }, []);
}
