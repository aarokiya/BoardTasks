import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Menu, type MenuEntry } from './Menu';
import type { ReactElement } from 'react';

interface ContextMenuState {
  open: boolean;
  anchor: HTMLElement | null;
}

/**
 * Opens a Menu at the pointer. Returns an `onContextMenu` handler plus the
 * element to render. The anchor is a zero-size element placed at the click
 * point so Menu's normal flip/clamp logic applies.
 */
export function useContextMenu(items: MenuEntry[], label: string): {
  onContextMenu: (e: ReactMouseEvent) => void;
  openAt: (x: number, y: number) => void;
  element: ReactElement | null;
} {
  const [state, setState] = useState<ContextMenuState>({ open: false, anchor: null });
  const holder = useRef<HTMLDivElement | null>(null);

  const openAt = useCallback((x: number, y: number) => {
    let el = holder.current;
    if (!el) {
      el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.pointerEvents = 'none';
      document.body.appendChild(el);
      holder.current = el;
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    setState({ open: true, anchor: el });
  }, []);

  const onContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openAt(e.clientX, e.clientY);
    },
    [openAt],
  );

  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);

  return {
    onContextMenu,
    openAt,
    element: state.open ? <Menu open onClose={close} anchor={state.anchor} items={items} label={label} /> : null,
  };
}
