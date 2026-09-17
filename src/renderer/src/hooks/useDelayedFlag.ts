import { useEffect, useState } from 'react';

/**
 * True only once `value` has stayed true for `delayMs`. Used so a 40ms sync
 * never flashes a spinner and a fast hydrate never flashes skeleton rows.
 */
export function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!value) return undefined;
    const t = setTimeout(() => setReady(true), delayMs);
    return () => {
      clearTimeout(t);
      setReady(false);
    };
  }, [value, delayMs]);
  return value && ready;
}
