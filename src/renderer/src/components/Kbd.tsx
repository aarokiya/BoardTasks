import type { ReactElement } from 'react';
import s from './controls.module.css';

/** Renders a shortcut string like '⌘⇧N' as individual key caps. */
export function Kbd({ keys }: { keys: string }): ReactElement {
  const parts = keys.match(/⌘|⇧|⌥|⌃|⌫|↑|↓|←|→|Space|Tab|Esc|Enter|[A-Za-z0-9=\-./\\,]/g) ?? [keys];
  return (
    <span aria-label={keys}>
      {parts.map((k, i) => (
        <span key={`${k}-${i}`} className={s.kbd}>
          {k}
        </span>
      ))}
    </span>
  );
}
