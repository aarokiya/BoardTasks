import { useEffect, type ReactElement, type ReactNode } from 'react';
import type { CommandId } from '../../commands/ids';
import { runCommand } from '../../commands/registry';
import { registerAllCommands } from '../../commands/impl';
import { onMainEvent } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { buildShortcutMap, chordId, eventChord, isBareKey, shortcutFor } from './keys';

// Registering here (not only from App.tsx) guarantees shortcuts work in any
// tree that mounts the scope — including a test that renders it alone.
registerAllCommands();

const SHORTCUTS = buildShortcutMap();

/** ⌘-shortcuts that stay live while a modal overlay is open. */
const ALLOWED_IN_OVERLAY = new Set<CommandId>(['view.palette', 'view.shortcuts', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'app.settings']);

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

/** Bare keys only fire from the task list (or from nothing in particular). */
function inTaskListScope(target: EventTarget | null): boolean {
  if (target === null) return true;
  if (!(target instanceof HTMLElement)) return true;
  if (target === document.body || target === document.documentElement) return true;
  return target.closest('[data-bt-list]') !== null;
}

export function handleShortcutKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false;
  // IME: ⏎ during Japanese composition commits the composition, never a command.
  if (e.isComposing || e.keyCode === 229) return false;

  const chord = eventChord(e);
  if (!chord.key) return false;

  const store = useStore.getState();

  if (chord.key === 'Escape' && isBareKey(chord) && !chord.shift) {
    if (store.overlay !== null) {
      e.preventDefault();
      store.closeOverlay();
      return true;
    }
    return false;
  }

  const binding = SHORTCUTS.get(chordId(chord));
  if (!binding) return false;

  if (isBareKey(chord)) {
    if (isEditable(e.target)) return false;
    if (store.overlay !== null) return false;
    if (!inTaskListScope(e.target)) return false;
  } else if (store.overlay !== null && !ALLOWED_IN_OVERLAY.has(binding.id)) {
    return false;
  }

  e.preventDefault();
  void runCommand(binding.id);
  return true;
}

/**
 * One keydown listener for the whole app. Components that want a key for
 * themselves (a text field, an open menu) call `stopPropagation` or
 * `preventDefault` — both are honoured here.
 */
export function KeyboardScope({ children }: { children?: ReactNode }): ReactElement {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      handleShortcutKey(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    // The native menu dispatches commands by id through the event channel.
    let off = (): void => {};
    try {
      off = onMainEvent((ev) => {
        if (ev.type === 'shortcut') void runCommand(ev.command as CommandId);
      });
    } catch {
      /* no preload bridge (unit tests) */
    }
    return () => off();
  }, []);

  return <>{children}</>;
}

/** The shortcut string for a command, for rendering a kbd hint. */
export function useShortcut(id: CommandId): string | undefined {
  return shortcutFor(id);
}
