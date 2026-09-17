import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Traps Tab inside `ref`, moves focus into it on mount, and restores focus to
 * the previously active element on unmount.
 *
 * Initial focus goes to `[data-bt-autofocus]` when the dialog names one,
 * otherwise to the dialog itself — never to whatever happens to be first in
 * the DOM, which is usually the header's close button and leaves a focus ring
 * sitting on "✕" the moment a sheet opens.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const preferred = root.querySelector<HTMLElement>('[data-bt-autofocus]');
    (preferred ?? root).focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === firstEl || activeEl === root)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [ref, active]);
}

/** Marks every direct child of #root inert while a modal is open. */
export function useInertBackground(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.getElementById('root');
    if (!root) return;
    const touched: HTMLElement[] = [];
    for (const child of Array.from(root.children)) {
      if (child instanceof HTMLElement && !child.hasAttribute('inert')) {
        child.setAttribute('inert', '');
        touched.push(child);
      }
    }
    return () => {
      for (const el of touched) el.removeAttribute('inert');
    };
  }, [active]);
}
