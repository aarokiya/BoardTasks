import { describe, expect, it, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { COMMANDS } from '../../../src/renderer/src/commands/ids';
import { KeyboardScope, useShortcut } from '../../../src/renderer/src/features/shortcuts/KeyboardScope';
import { parseShortcut } from '../../../src/renderer/src/features/shortcuts/keys';
import { useStore } from '../../../src/renderer/src/store/store';
import { installMockApi, makeTask } from '../../setup/mockApi';

function mount(): HTMLElement {
  const { container } = render(
    <KeyboardScope>
      <div data-bt-list="" data-testid="list">
        <input data-testid="field" />
      </div>
    </KeyboardScope>,
  );
  return container;
}

async function hydrateWith(taskId = 't1'): Promise<void> {
  installMockApi({ tasks: [makeTask({ id: taskId, title: 'A', listId: 'list-1' })] });
  await useStore.getState().hydrate();
  useStore.getState().select([taskId]);
}

const key = (target: EventTarget, init: KeyboardEventInit): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};

beforeEach(() => {
  useStore.setState({ overlay: null, selection: [], focusId: null, tasks: {}, undoPast: [], undoFuture: [] });
});

describe('KeyboardScope scope rules', () => {
  it('fires a bare shortcut from inside the task list', async () => {
    await hydrateWith();
    const container = mount();
    const list = container.querySelector('[data-bt-list]')!;
    key(list, { key: 't', code: 'KeyT' });
    await waitFor(() => expect(useStore.getState().tasks['t1']?.due).toBe(useStore.getState().today));
  });

  it('ignores a bare shortcut typed into an input', async () => {
    await hydrateWith();
    const container = mount();
    const field = container.querySelector('input')!;
    key(field, { key: 't', code: 'KeyT' });
    await new Promise((r) => setTimeout(r, 10));
    expect(useStore.getState().tasks['t1']?.due).toBeNull();
  });

  it('ignores a bare shortcut from outside the task list', async () => {
    await hydrateWith();
    mount();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    key(outside, { key: 't', code: 'KeyT' });
    await new Promise((r) => setTimeout(r, 10));
    expect(useStore.getState().tasks['t1']?.due).toBeNull();
  });

  it('fires a ⌘ shortcut from anywhere', async () => {
    mount();
    key(document.body, { key: 'k', code: 'KeyK', metaKey: true });
    await waitFor(() => expect(useStore.getState().overlay).toBe('palette'));
  });

  it('suppresses bare shortcuts while an overlay is open', async () => {
    await hydrateWith();
    mount();
    useStore.getState().openOverlay('settings');
    const list = document.querySelector('[data-bt-list]')!;
    key(list, { key: 't', code: 'KeyT' });
    await new Promise((r) => setTimeout(r, 10));
    expect(useStore.getState().tasks['t1']?.due).toBeNull();
  });

  it('lets ⌘K through while an overlay is open', async () => {
    mount();
    useStore.getState().openOverlay('settings');
    key(document.body, { key: 'k', code: 'KeyK', metaKey: true });
    await waitFor(() => expect(useStore.getState().overlay).toBe('palette'));
  });

  it('blocks other ⌘ shortcuts while an overlay is open', async () => {
    await hydrateWith();
    mount();
    useStore.getState().openOverlay('settings');
    key(document.body, { key: 'd', code: 'KeyD', metaKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(Object.keys(useStore.getState().tasks)).toHaveLength(1);
  });

  it('Escape closes the topmost overlay first', () => {
    mount();
    useStore.getState().openOverlay('outbox');
    key(document.body, { key: 'Escape', code: 'Escape' });
    expect(useStore.getState().overlay).toBeNull();
  });

  it('Escape with no overlay is left alone', () => {
    mount();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('honours preventDefault from a component that already handled the key', async () => {
    await hydrateWith();
    mount();
    const list = document.querySelector('[data-bt-list]')!;
    const ev = new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true, cancelable: true });
    ev.preventDefault();
    list.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 10));
    expect(useStore.getState().tasks['t1']?.due).toBeNull();
  });
});

describe('IME composition', () => {
  it('ignores a keydown while composing', async () => {
    mount();
    key(document.body, { key: 'k', code: 'KeyK', metaKey: true, isComposing: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(useStore.getState().overlay).toBeNull();
  });

  it('ignores the legacy keyCode 229 composition signal', async () => {
    mount();
    key(document.body, { key: 'k', code: 'KeyK', metaKey: true, keyCode: 229 });
    await new Promise((r) => setTimeout(r, 10));
    expect(useStore.getState().overlay).toBeNull();
  });
});

describe('dispatching every registered shortcut', () => {
  it('handles every shortcut in COMMANDS without throwing', () => {
    mount();
    for (const c of COMMANDS) {
      if (!('shortcut' in c) || !c.shortcut) continue;
      const chord = parseShortcut(c.shortcut)!;
      const code = /^[A-Z]$/.test(chord.key) ? `Key${chord.key}` : /^[0-9]$/.test(chord.key) ? `Digit${chord.key}` : chord.key;
      expect(() =>
        key(document.body, {
          key: chord.key,
          code,
          metaKey: chord.meta,
          ctrlKey: chord.ctrl,
          altKey: chord.alt,
          shiftKey: chord.shift,
        }),
      ).not.toThrow();
      useStore.getState().closeOverlay();
    }
  });
});

describe('main-process shortcut events', () => {
  it('runs a command dispatched from the native menu', async () => {
    const api = installMockApi();
    await useStore.getState().hydrate();
    mount();
    api.emit({ type: 'shortcut', command: 'view.shortcuts' });
    await waitFor(() => expect(useStore.getState().overlay).toBe('shortcuts'));
  });
});

describe('useShortcut', () => {
  it('returns the registry shortcut for a command', () => {
    let seen: string | undefined;
    function Probe(): null {
      seen = useShortcut('view.palette');
      return null;
    }
    render(<Probe />);
    expect(seen).toBe('⌘K');
  });
});
