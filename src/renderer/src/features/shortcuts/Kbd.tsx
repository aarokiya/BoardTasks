import type { ReactElement } from 'react';
import { shortcutAria, shortcutGlyphs } from './keys';
import s from './Kbd.module.css';

/** Keyboard hint. Renders nothing when the command has no shortcut. */
export function Kbd({ shortcut, muted = false }: { shortcut?: string | undefined; muted?: boolean }): ReactElement | null {
  if (!shortcut) return null;
  const glyphs = shortcutGlyphs(shortcut);
  if (glyphs.length === 0) return null;
  return (
    <span className={muted ? `${s.group} ${s.muted}` : s.group} aria-label={shortcutAria(shortcut)} role="img">
      {glyphs.map((g, i) => (
        <kbd key={`${g}-${i}`} className={s.key} aria-hidden="true">
          {g}
        </kbd>
      ))}
    </span>
  );
}
