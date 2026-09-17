import { useCallback, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Popover } from './Popover';
import { cx } from './cx';
import s from './overlays.module.css';

export interface MenuAction {
  kind?: 'item';
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
}
export interface MenuSeparator { kind: 'separator'; id: string }
export interface MenuGroupLabel { kind: 'label'; id: string; label: string }
export interface MenuCustom { kind: 'custom'; id: string; render: (close: () => void) => ReactNode }
export type MenuEntry = MenuAction | MenuSeparator | MenuGroupLabel | MenuCustom;

const isAction = (e: MenuEntry): e is MenuAction => e.kind === undefined || e.kind === 'item';

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  items: MenuEntry[];
  label: string;
  placement?: 'bottom-start' | 'bottom-end' | 'right';
}

export function Menu({ open, onClose, anchor, items, label, placement = 'bottom-start' }: MenuProps): ReactElement | null {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const enabled = items.filter(isAction).filter((i) => !i.disabled);
  // Derived, never synced in an effect: the first enabled item is active until
  // the pointer or the keyboard picks another one.
  const activeId = (pickedId !== null && enabled.some((i) => i.id === pickedId) ? pickedId : null) ?? enabled[0]?.id ?? null;
  const close = useCallback(() => {
    setPickedId(null);
    onClose();
  }, [onClose]);

  const move = useCallback(
    (delta: number) => {
      if (enabled.length === 0) return;
      const idx = enabled.findIndex((a) => a.id === activeId);
      const next = enabled[(idx + delta + enabled.length) % enabled.length];
      setPickedId(next?.id ?? null);
    },
    [enabled, activeId],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setPickedId(enabled[0]?.id ?? null); }
    else if (e.key === 'End') { e.preventDefault(); setPickedId(enabled[enabled.length - 1]?.id ?? null); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const a = enabled.find((x) => x.id === activeId);
      if (a) { close(); a.onSelect(); }
    }
  };

  return (
    <Popover open={open} onClose={close} anchor={anchor} placement={placement} label={label} role="menu" flush>
      <div className={s.menu} role="none" onKeyDown={onKeyDown}>
        {items.map((entry) => {
          if (entry.kind === 'separator') return <div key={entry.id} className={s.menuSeparator} role="separator" />;
          if (entry.kind === 'label') return <div key={entry.id} className={s.menuGroupLabel}>{entry.label}</div>;
          if (entry.kind === 'custom') return <div key={entry.id} role="none">{entry.render(close)}</div>;
          return (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              aria-disabled={entry.disabled || undefined}
              tabIndex={entry.id === activeId ? 0 : -1}
              className={cx(s.menuItem, entry.id === activeId && s.menuItemActive, entry.danger && s.menuItemDanger)}
              onMouseEnter={() => !entry.disabled && setPickedId(entry.id)}
              onClick={() => {
                if (entry.disabled) return;
                close();
                entry.onSelect();
              }}
            >
              <span className={s.menuIcon} aria-hidden="true">{entry.checked ? '✓' : entry.icon}</span>
              <span className={s.menuLabel}>{entry.label}</span>
              {entry.shortcut ? <span className={s.menuShortcut}>{entry.shortcut}</span> : null}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
