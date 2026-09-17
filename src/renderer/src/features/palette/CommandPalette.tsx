import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@shared/models';
import type { ViewId } from '@shared/constants';
import { announce } from '../../lib/announce';
import { call } from '../../lib/ipc';
import { runCommand } from '../../commands/registry';
import { useStore } from '../../store/store';
import { useInertBackground } from '../../hooks/useFocusTrap';
import { Kbd } from '../shortcuts/Kbd';
import { highlight } from './fuzzy';
import { buildSections, flatten, parseMode, taskScopedCommands, type PaletteItem, type PaletteSection } from './sources';
import { bumpCommandUsage, pushRecentTask } from './usage';
import s from './CommandPalette.module.css';

const LIST_ID = 'bt-palette-list';
const optionId = (i: number): string => `bt-palette-option-${i}`;

const MODE_HINT: Record<string, string> = {
  '>': 'Actions',
  '#': 'Lists',
  '@': 'Tasks',
  gh: 'GitHub',
};

function Highlighted({ text, positions }: { text: string; positions: number[] }): ReactElement {
  return (
    <>
      {highlight(text, positions).map((seg, i) =>
        seg.match ? (
          <mark key={i} className={s.mark}>
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

/** ⌘K. Fuzzy search across actions, tasks, lists, views and linked GitHub items. */
export function CommandPalette(): ReactElement | null {
  const open = useStore((st) => st.overlay === 'palette');
  // Remounting on every open is what resets the query, the active row and the
  // focus restore target — no setState-in-effect anywhere.
  return open ? <PaletteDialog /> : null;
}

function PaletteDialog(): ReactElement {
  const version = useStore((st) => st.version);
  const [raw, setRaw] = useState('');
  const [activeIdxRaw, setActiveIdx] = useState(0);
  const [scope, setScope] = useState<Task | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Hover must not steal the active row while the user is typing. Only a real
  // pointer movement re-arms it.
  const hoverArmed = useRef(false);

  // aria-modal alone does not hide the app from assistive tech. This only
  // works because the palette is portalled to <body>: useInertBackground marks
  // every child of #root inert, which would otherwise include the palette.
  useInertBackground(true);

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      restore?.focus?.();
    };
  }, []);

  const sections: PaletteSection[] = useMemo(() => {
    // `version` is a dependency so results re-rank when data changes.
    void version;
    const state = useStore.getState();
    if (scope) {
      const items = taskScopedCommands(parseMode(raw).query);
      return items.length ? [{ title: scope.title || 'Task', items }] : [];
    }
    return buildSections(raw, state);
  }, [raw, scope, version]);

  const items = useMemo(() => flatten(sections), [sections]);
  // Clamp during render rather than correcting it in an effect.
  const activeIdx = items.length === 0 ? 0 : Math.min(activeIdxRaw, items.length - 1);

  useEffect(() => {
    const el = listRef.current?.querySelector(`#${optionId(activeIdx)}`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, items.length]);

  const close = useCallback(() => {
    useStore.getState().closeOverlay();
  }, []);

  const activate = useCallback(
    async (item: PaletteItem, secondary: boolean): Promise<void> => {
      const store = useStore.getState();
      switch (item.kind) {
        case 'command': {
          if (!item.enabled) return;
          bumpCommandUsage(item.id);
          close();
          await runCommand(item.id);
          return;
        }
        case 'task': {
          pushRecentTask(item.task.id);
          if (secondary) {
            store.select([item.task.id]);
            store.setFocus(item.task.id);
            close();
            await runCommand('task.complete');
            return;
          }
          store.setView(`list:${item.task.listId}` as ViewId);
          store.select([item.task.id]);
          store.setFocus(item.task.id);
          close();
          announce(`Opened ${item.task.title || 'task'}`);
          return;
        }
        case 'list': {
          store.setView(`list:${item.list.id}` as ViewId);
          close();
          return;
        }
        case 'view': {
          store.setView(item.view);
          close();
          return;
        }
        case 'github': {
          if (secondary) {
            store.setView(`list:${item.task.listId}` as ViewId);
            store.select([item.task.id]);
            store.setFocus(item.task.id);
            close();
            return;
          }
          close();
          await call('app:openExternal', { url: item.url }).catch(() => undefined);
          return;
        }
        default:
          return;
      }
    },
    [close],
  );

  const drillInto = useCallback((item: PaletteItem) => {
    if (item.kind !== 'task') return;
    const store = useStore.getState();
    store.select([item.task.id]);
    store.setFocus(item.task.id);
    setScope(item.task);
    setRaw('');
    setActiveIdx(0);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    hoverArmed.current = false;
    const max = items.length - 1;
    const move = (delta: number): void => {
      e.preventDefault();
      if (max < 0) return;
      setActiveIdx((i) => (i + delta < 0 ? max : i + delta > max ? 0 : i + delta));
    };

    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) return move(1);
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) return move(-1);

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (scope) {
        setScope(null);
        setRaw('');
        setActiveIdx(0);
      } else close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[activeIdx];
      if (item) void activate(item, e.metaKey);
      return;
    }
    if (e.key === 'ArrowRight' && !scope) {
      const input = e.currentTarget;
      if (input.selectionStart === raw.length && input.selectionEnd === raw.length) {
        const item = items[activeIdx];
        if (item?.kind === 'task') {
          e.preventDefault();
          drillInto(item);
        }
      }
      return;
    }
    if (e.key === 'Backspace' && raw === '' && scope) {
      e.preventDefault();
      setScope(null);
      return;
    }
  };

  const { prefix } = parseMode(raw);
  const activeItem = items[activeIdx];

  return createPortal(
    <div className={s.scrim} onMouseDown={close} data-testid="command-palette">
      <div
        className={s.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseMove={() => {
          hoverArmed.current = true;
        }}
      >
        <div className={s.inputRow}>
          {scope ? (
            <span className={s.pill} data-testid="palette-scope">
              {scope.title || 'Task'}
            </span>
          ) : prefix ? (
            <span className={s.pill}>{MODE_HINT[prefix] ?? prefix}</span>
          ) : null}
          <input
            ref={inputRef}
            className={s.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(activeIdx) : undefined}
            aria-label={scope ? `Actions for ${scope.title || 'task'}` : 'Search commands, tasks and lists'}
            placeholder={scope ? 'Action…' : 'Search tasks, lists and commands…'}
            spellCheck={false}
            autoComplete="off"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setActiveIdx(0);
              hoverArmed.current = false;
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        {items.length === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>
              {raw.trim() ? <>Nothing matches &ldquo;{raw.trim()}&rdquo;</> : 'Nothing to show yet'}
            </p>
            <p className={s.emptyBody}>Narrow the search to one kind of thing:</p>
            <ul className={s.emptyModes}>
              <li>
                <kbd className={s.hintKey}>&gt;</kbd> actions
              </li>
              <li>
                <kbd className={s.hintKey}>@</kbd> tasks
              </li>
              <li>
                <kbd className={s.hintKey}>#</kbd> lists
              </li>
              <li>
                <kbd className={s.hintKey}>gh</kbd> GitHub
              </li>
            </ul>
          </div>
        ) : (
          <ul className={s.list} id={LIST_ID} role="listbox" aria-label="Results" ref={listRef}>
            {sections.map((section) => {
              const start = items.indexOf(section.items[0]!);
              return (
                <Fragment key={section.title}>
                  <li className={s.groupHeader} role="presentation">
                    {section.title}
                  </li>
                  {section.items.map((item, j) => {
                    const idx = start + j;
                    const disabled = item.kind === 'command' && !item.enabled;
                    return (
                      <li
                        key={item.key}
                        id={optionId(idx)}
                        role="option"
                        aria-selected={idx === activeIdx}
                        aria-disabled={disabled || undefined}
                        className={[s.option, idx === activeIdx ? s.active : '', disabled ? s.disabled : '', item.kind === 'command' && item.destructive ? s.destructive : ''].filter(Boolean).join(' ')}
                        onMouseMove={() => {
                          if (hoverArmed.current && idx !== activeIdx) setActiveIdx(idx);
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => void activate(item, e.metaKey)}
                      >
                        <span className={s.optionMain}>
                          <span className={s.optionLabel}>
                            <Highlighted text={item.label} positions={item.positions} />
                          </span>
                          {item.subtitle ? <span className={s.optionSub}>{item.subtitle}</span> : null}
                        </span>
                        {disabled && item.kind === 'command' && item.reason ? <span className={s.reason}>{item.reason}</span> : null}
                        {item.kind === 'command' ? <Kbd shortcut={item.shortcut} muted /> : null}
                        {item.kind === 'task' && !scope ? <span className={s.drill} aria-hidden="true">→</span> : null}
                      </li>
                    );
                  })}
                </Fragment>
              );
            })}
          </ul>
        )}

        <footer className={s.footer}>
          <span>
            <kbd className={s.hintKey}>↵</kbd> open
          </span>
          <span>
            <kbd className={s.hintKey}>⌘↵</kbd> complete
          </span>
          <span>
            <kbd className={s.hintKey}>→</kbd> actions
          </span>
          <span>
            <kbd className={s.hintKey}>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
