import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { Popover } from '../../components/Popover';
import { IconCheck } from '../../components/icons';
import { cx } from '../../components/cx';
import { useStore } from '../../store/store';
import { selectLists } from '../../store/selectors/views';
import s from './DetailPane.module.css';

export interface ListPickerBodyProps {
  value: string | null;
  onChange: (listId: string) => void;
  onDone: () => void;
  autoFocus?: boolean;
}

/** Searchable `role="listbox"` over the user's lists. */
export function ListPickerBody({ value, onChange, onDone, autoFocus = true }: ListPickerBodyProps): ReactElement {
  const lists = useStore(selectLists);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(() => {
    const i = lists.findIndex((l) => l.id === value);
    return i >= 0 ? i : 0;
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? lists : lists.filter((l) => l.title.toLowerCase().includes(q));
  }, [lists, query]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const safeIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  const commit = (id: string): void => {
    onChange(id);
    onDone();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((safeIndex + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((safeIndex - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(filtered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const l = filtered[safeIndex];
      if (l) commit(l.id);
    }
  };

  const activeId = filtered[safeIndex]?.id;

  return (
    <div className={s.listPicker} onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        type="text"
        className={s.listSearch}
        placeholder="Search lists…"
        aria-label="Search lists"
        aria-controls="bt-listpicker-options"
        aria-activedescendant={activeId ? `bt-listopt-${activeId}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setActiveIndex(0);
        }}
      />
      <div id="bt-listpicker-options" role="listbox" aria-label="Lists" className={s.listOptions}>
        {filtered.length === 0 ? (
          <div className={s.listEmpty}>No lists match “{query.trim()}”.</div>
        ) : (
          filtered.map((l, i) => (
            <button
              key={l.id}
              id={`bt-listopt-${l.id}`}
              type="button"
              role="option"
              aria-selected={l.id === value}
              tabIndex={-1}
              className={cx(s.listOption, i === safeIndex && s.listOptionActive)}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => commit(l.id)}
            >
              <span className={s.listDot} style={{ background: `var(--bt-list-${l.color})` }} aria-hidden="true" />
              <span className={s.listOptionLabel}>{l.title}</span>
              {l.id === value ? (
                <span className={s.listOptionCheck} aria-hidden="true">
                  <IconCheck size={13} />
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export interface ListPickerPopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  value: string | null;
  onChange: (listId: string) => void;
}

export function ListPickerPopover({ open, onClose, anchor, value, onChange }: ListPickerPopoverProps): ReactElement | null {
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="bottom-start" label="Move to list" role="dialog" flush autoFocus={false}>
      <ListPickerBody value={value} onChange={onChange} onDone={onClose} />
    </Popover>
  );
}
