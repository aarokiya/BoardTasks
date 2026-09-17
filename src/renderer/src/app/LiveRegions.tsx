import type { ReactElement } from 'react';
import s from './Toaster.module.css';

/**
 * The two announce() targets. Mounted exactly once, before anything that can
 * announce, and never re-rendered — announce() writes textContent directly.
 */
export function LiveRegions(): ReactElement {
  return (
    <>
      <div id="bt-status" className={s.live} role="status" aria-live="polite" aria-atomic="true" />
      <div id="bt-alert" className={s.live} role="alert" aria-live="assertive" aria-atomic="true" />
    </>
  );
}
