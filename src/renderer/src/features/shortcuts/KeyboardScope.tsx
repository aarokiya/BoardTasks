import type { ReactElement, ReactNode } from 'react';
/** Owned by the Interactions track. Wraps the app; dispatches shortcuts to the command registry. */
export function KeyboardScope({ children }: { children: ReactNode }): ReactElement {
  return <>{children}</>;
}
