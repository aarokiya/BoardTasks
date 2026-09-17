import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { COMMANDS, type CommandMeta } from '../../commands/ids';
import { useStore } from '../../store/store';
import { fuzzyMatch } from '../palette/fuzzy';
import { Kbd } from './Kbd';
import { shortcutAria } from './keys';
import s from './ShortcutsOverlay.module.css';

const GROUP_ORDER: Array<CommandMeta['group']> = ['Create', 'Task', 'Edit', 'Navigate', 'View', 'Sync', 'GitHub', 'App'];

const ALL_COMMANDS: readonly CommandMeta[] = COMMANDS;

interface Section {
  group: CommandMeta['group'];
  items: CommandMeta[];
}

function sections(query: string): Section[] {
  const q = query.trim();
  const matches = (c: CommandMeta): boolean => {
    if (!q) return true;
    if (fuzzyMatch(q, c.label)) return true;
    if (c.shortcut && shortcutAria(c.shortcut).toLowerCase().includes(q.toLowerCase())) return true;
    return (c.keywords ?? []).some((k) => fuzzyMatch(q, k) !== null);
  };
  const out: Section[] = [];
  for (const group of GROUP_ORDER) {
    const items = ALL_COMMANDS.filter((c) => c.group === group && c.shortcut && matches(c));
    if (items.length) out.push({ group, items });
  }
  return out;
}

/** Cheat sheet generated from the command registry. Toggled with ⌘/. */
export function ShortcutsOverlay(): ReactElement | null {
  const open = useStore((st) => st.overlay === 'shortcuts');
  // Mounting fresh each time is what resets the filter and restores focus,
  // without a single setState-in-effect.
  return open ? <ShortcutsSheet /> : null;
}

function ShortcutsSheet(): ReactElement {
  const closeOverlay = useStore((st) => st.closeOverlay);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => restore?.focus?.();
  }, []);

  const list = useMemo(() => sections(query), [query]);

  return (
    <div className={s.scrim} onMouseDown={closeOverlay} data-testid="shortcuts-overlay">
      <div
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={s.header}>
          <h2 className={s.title}>Keyboard Shortcuts</h2>
          <input
            ref={inputRef}
            className={s.search}
            type="text"
            value={query}
            placeholder="Filter…"
            aria-label="Filter shortcuts"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeOverlay();
              }
            }}
          />
        </header>
        <div className={s.body}>
          {list.length === 0 ? (
            <p className={s.empty}>No shortcuts match “{query}”.</p>
          ) : (
            list.map((section) => (
              <section key={section.group} className={s.group}>
                <h3 className={s.groupTitle}>{section.group}</h3>
                <ul className={s.rows}>
                  {section.items.map((c) => (
                    <li key={c.id} className={s.row}>
                      <span className={s.label}>{c.label}</span>
                      <Kbd shortcut={c.shortcut} />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        <footer className={s.footer}>
          <span>Single-letter shortcuts apply to the focused task.</span>
          <button type="button" className={s.close} onClick={closeOverlay}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
