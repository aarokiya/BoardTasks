import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { COMMANDS } from '../../../src/renderer/src/commands/ids';
import { ShortcutsOverlay } from '../../../src/renderer/src/features/shortcuts/ShortcutsOverlay';
import { useStore } from '../../../src/renderer/src/store/store';

const open = (): void => useStore.getState().openOverlay('shortcuts');
const search = (): HTMLInputElement => screen.getByLabelText('Filter shortcuts');

beforeEach(() => {
  useStore.setState({ overlay: null });
});

describe('ShortcutsOverlay', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ShortcutsOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a modal cheat sheet', () => {
    open();
    render(<ShortcutsOverlay />);
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('lists every command that has a shortcut', () => {
    open();
    render(<ShortcutsOverlay />);
    const withShortcut = COMMANDS.filter((c) => 'shortcut' in c && !!c.shortcut);
    for (const c of withShortcut) expect(screen.getAllByText(c.label).length, c.label).toBeGreaterThan(0);
  });

  it('groups by command group', () => {
    open();
    render(<ShortcutsOverlay />);
    expect(screen.getByRole('heading', { name: 'Create' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Task' })).toBeInTheDocument();
  });

  it('renders glyphs with a spoken label', () => {
    open();
    render(<ShortcutsOverlay />);
    expect(screen.getByRole('img', { name: 'Command K' })).toBeInTheDocument();
  });

  it('filters by label', () => {
    open();
    render(<ShortcutsOverlay />);
    fireEvent.change(search(), { target: { value: 'palette' } });
    expect(screen.getByText('Command Palette')).toBeInTheDocument();
    expect(screen.queryByText('New List')).not.toBeInTheDocument();
  });

  it('filters by the spoken shortcut', () => {
    open();
    render(<ShortcutsOverlay />);
    fireEvent.change(search(), { target: { value: 'option up' } });
    expect(screen.getByText('Move Up')).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    open();
    render(<ShortcutsOverlay />);
    fireEvent.change(search(), { target: { value: 'zzzqqq' } });
    expect(screen.getByText(/No shortcuts match/)).toBeInTheDocument();
  });

  it('focuses the filter on open and restores focus on close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    open();
    const { rerender } = render(<ShortcutsOverlay />);
    await waitFor(() => expect(document.activeElement).toBe(search()));
    fireEvent.keyDown(search(), { key: 'Escape' });
    rerender(<ShortcutsOverlay />);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('closes from the Done button', () => {
    open();
    render(<ShortcutsOverlay />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(useStore.getState().overlay).toBeNull();
  });

  it('closes when the scrim is clicked', () => {
    open();
    render(<ShortcutsOverlay />);
    fireEvent.mouseDown(screen.getByTestId('shortcuts-overlay'));
    expect(useStore.getState().overlay).toBeNull();
  });

  it('stays open when the sheet itself is clicked', () => {
    open();
    render(<ShortcutsOverlay />);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(useStore.getState().overlay).toBe('shortcuts');
  });
});
