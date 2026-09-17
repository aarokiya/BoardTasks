import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CommandPalette } from '../../../src/renderer/src/features/palette/CommandPalette';
import { registerAllCommands } from '../../../src/renderer/src/commands/impl';
import { useStore } from '../../../src/renderer/src/store/store';
import { installMockApi, makeList, makeTask, type MockApi } from '../../setup/mockApi';

async function setup(): Promise<MockApi> {
  const api = installMockApi({
    lists: [makeList({ id: 'list-1', title: 'Inbox', isDefault: true }), makeList({ id: 'list-2', title: 'Work', isDefault: false })],
    tasks: [
      makeTask({ id: 't1', title: 'Tabulate results', listId: 'list-1' }),
      makeTask({ id: 't2', title: 'Take out the bins', listId: 'list-2' }),
    ],
  });
  useStore.setState({ tasks: {}, lists: {}, selection: [], focusId: null, overlay: null, undoPast: [], undoFuture: [] });
  await useStore.getState().hydrate();
  registerAllCommands();
  useStore.getState().openOverlay('palette');
  return api;
}

const input = (): HTMLInputElement => screen.getByRole('combobox');
const options = (): HTMLElement[] => screen.getAllByRole('option');
const activeLabel = (): string => {
  const id = input().getAttribute('aria-activedescendant')!;
  return document.getElementById(id)!.textContent ?? '';
};

beforeEach(() => {
  useStore.setState({ overlay: null });
});

describe('CommandPalette', () => {
  it('renders nothing until the overlay opens', async () => {
    await setup();
    useStore.setState({ overlay: null });
    const { container } = render(<CommandPalette />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a dialog with a listbox', async () => {
    await setup();
    render(<CommandPalette />);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Results' })).toBeInTheDocument();
  });

  it('focuses the input on open', async () => {
    await setup();
    render(<CommandPalette />);
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it('shows Actions and Views with an empty query', async () => {
    await setup();
    render(<CommandPalette />);
    const headers = screen.getAllByRole('presentation').map((h) => h.textContent);
    expect(headers).toEqual(['Actions', 'Views']);
  });

  it('orders groups Actions, Tasks, Lists, Views', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: 'ta' } });
    const headers = screen.getAllByRole('presentation').map((h) => h.textContent);
    expect(headers.filter((h) => h === 'Actions' || h === 'Tasks')).toEqual(['Actions', 'Tasks']);
    expect(headers.indexOf('Tasks')).toBeLessThan(headers.length);
  });

  it('> restricts the palette to actions', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '>new' } });
    expect(screen.getAllByRole('presentation').map((h) => h.textContent)).toEqual(['Actions']);
  });

  it('@ restricts the palette to tasks', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@' } });
    expect(screen.getAllByRole('presentation').map((h) => h.textContent)).toEqual(['Tasks']);
    expect(options()).toHaveLength(2);
  });

  it('# restricts the palette to lists and views', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '#work' } });
    const headers = screen.getAllByRole('presentation').map((h) => h.textContent);
    expect(headers).toContain('Lists');
    expect(headers).not.toContain('Actions');
  });

  it('shows a mode pill for a prefix', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '>' } });
    expect(screen.getByTestId('command-palette').querySelector('span[class*="pill"]')).toHaveTextContent('Actions');
  });

  it('moves aria-activedescendant with the arrow keys', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@' } });
    const first = activeLabel();
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    expect(activeLabel()).not.toBe(first);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  });

  it('supports ⌃N / ⌃P', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@' } });
    fireEvent.keyDown(input(), { key: 'n', ctrlKey: true });
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    fireEvent.keyDown(input(), { key: 'p', ctrlKey: true });
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  });

  it('wraps around at the ends', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@' } });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().getAttribute('aria-activedescendant')).toBe(options().at(-1)!.id);
  });

  it('marks exactly one option aria-selected', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@' } });
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });

  it('does not let hover steal the active row while typing', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@' } });
    const before = input().getAttribute('aria-activedescendant');
    fireEvent.mouseMove(options()[1]!);
    expect(input().getAttribute('aria-activedescendant')).toBe(before);
  });

  it('lets hover take over after a real pointer move', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@' } });
    fireEvent.mouseMove(screen.getByRole('dialog'));
    fireEvent.mouseMove(options()[1]!);
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
  });

  it('Enter opens the active task and closes', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@Tabulate' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(useStore.getState().overlay).toBeNull());
    expect(useStore.getState().selection).toEqual(['t1']);
    expect(useStore.getState().view).toBe('list:list-1');
  });

  it('⌘Enter completes the active task', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '@Tabulate' } });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(useStore.getState().tasks['t1']?.status).toBe('completed'));
  });

  it('→ drills into task-scoped actions and Esc backs out', async () => {
    await setup();
    render(<CommandPalette />);
    const el = input();
    fireEvent.change(el, { target: { value: '@Tabulate' } });
    el.setSelectionRange(el.value.length, el.value.length);
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(screen.getByTestId('palette-scope')).toHaveTextContent('Tabulate results');
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByTestId('palette-scope')).not.toBeInTheDocument();
    expect(useStore.getState().overlay).toBe('palette');
  });

  it('Esc closes the palette', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(useStore.getState().overlay).toBeNull();
  });

  it('clicking the scrim closes the palette', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.mouseDown(screen.getByTestId('command-palette'));
    expect(useStore.getState().overlay).toBeNull();
  });

  it('restores focus to the previously focused element', async () => {
    await setup();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = render(<CommandPalette />);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    fireEvent.keyDown(input(), { key: 'Escape' });
    rerender(<CommandPalette />);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('shows a curated empty state that names the search modes', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: 'zzzzqqq' } });
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    const modes = within(screen.getByRole('list'));
    expect(modes.getByText('actions')).toBeInTheDocument();
    expect(modes.getByText('GitHub')).toBeInTheDocument();
  });

  it('shows a keyboard hint next to a command', async () => {
    await setup();
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '>Command Palette' } });
    const first = options()[0]!;
    expect(within(first).getByRole('img', { name: 'Command K' })).toBeInTheDocument();
  });

  it('greys out a disabled command that matches by name', async () => {
    await setup();
    useStore.setState({ selection: [], focusId: null });
    render(<CommandPalette />);
    fireEvent.change(input(), { target: { value: '>Duplicate' } });
    const first = options()[0]!;
    expect(first).toHaveAttribute('aria-disabled', 'true');
    expect(first).toHaveTextContent('Not available right now');
  });

  it('never lists a disabled command on an empty query', async () => {
    await setup();
    useStore.setState({ selection: [], focusId: null });
    render(<CommandPalette />);
    expect(options().every((o) => o.getAttribute('aria-disabled') !== 'true')).toBe(true);
  });
});
