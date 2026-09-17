import type { ReactElement, ReactNode } from 'react';

export function VisuallyHidden({ children }: { children: ReactNode }): ReactElement {
  return <span className="sr-only">{children}</span>;
}
