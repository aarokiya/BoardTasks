import { useEffect, useState, type RefObject } from 'react';

export type LayoutMode = 'stack' | 'overlay' | 'rail' | 'clamped' | 'full';

export const LAYOUT_MODES: LayoutMode[] = ['stack', 'overlay', 'rail', 'clamped', 'full'];
/** Lower bound of modes 1..4. Mode i occupies [BOUNDS[i-1], BOUNDS[i]). */
export const BOUNDS = [620, 780, 940, 1120];
/** Hysteresis: a slow drag must overshoot by this much before the mode flips. */
export const HYSTERESIS = 24;

/** Pure transition so it can be unit-tested without a DOM. */
export function nextMode(current: LayoutMode, width: number): LayoutMode {
  let i = LAYOUT_MODES.indexOf(current);
  if (i < 0) i = LAYOUT_MODES.length - 1;
  while (i < BOUNDS.length && width >= (BOUNDS[i] ?? Infinity) + HYSTERESIS) i++;
  while (i > 0 && width < (BOUNDS[i - 1] ?? 0) - HYSTERESIS) i--;
  return LAYOUT_MODES[i] ?? 'full';
}

export function modeFromWidth(width: number): LayoutMode {
  let i = 0;
  while (i < BOUNDS.length && width >= (BOUNDS[i] ?? Infinity)) i++;
  return LAYOUT_MODES[i] ?? 'full';
}

/** Observes the element and returns the responsive layout mode with hysteresis. */
export function useLayoutMode(ref: RefObject<HTMLElement | null>): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() => modeFromWidth(typeof window === 'undefined' ? 1400 : window.innerWidth));

  useEffect(() => {
    const el = ref.current;
    const apply = (w: number): void => setMode((cur) => nextMode(cur, w));
    if (!el || typeof ResizeObserver !== 'function') {
      const onResize = (): void => apply(window.innerWidth);
      const armed = setTimeout(onResize, 0);
      window.addEventListener('resize', onResize);
      return () => {
        clearTimeout(armed);
        window.removeEventListener('resize', onResize);
      };
    }
    // ResizeObserver fires once on observe, which seeds the initial mode.
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number' && w > 0) apply(w);
    });
    ro.observe(el);
    const armed = setTimeout(() => apply(el.getBoundingClientRect().width || window.innerWidth), 0);
    return () => {
      clearTimeout(armed);
      ro.disconnect();
    };
  }, [ref]);

  return mode;
}

export interface PaneLayout {
  sidebar: 'full' | 'rail' | 'hidden';
  detail: 'inline' | 'sheet' | 'fullscreen';
  detailMaxWidth: number | null;
}

export function paneLayout(mode: LayoutMode): PaneLayout {
  switch (mode) {
    case 'full': return { sidebar: 'full', detail: 'inline', detailMaxWidth: null };
    case 'clamped': return { sidebar: 'full', detail: 'inline', detailMaxWidth: 300 };
    case 'rail': return { sidebar: 'rail', detail: 'inline', detailMaxWidth: 300 };
    case 'overlay': return { sidebar: 'hidden', detail: 'sheet', detailMaxWidth: 340 };
    case 'stack': return { sidebar: 'hidden', detail: 'fullscreen', detailMaxWidth: null };
  }
}
