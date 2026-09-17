import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuickAddApp } from '../../../src/renderer/src/features/quickadd/QuickAddApp';
import { installMockApi, makeList, type MockApi } from '../../setup/mockApi';

function setup(): MockApi {
  return installMockApi({
    lists: [makeList({ id: 'list-1', title: 'Inbox', isDefault: true }), makeList({ id: 'list-2', title: 'Work', isDefault: false })],
    settings: { defaultListId: 'list-1' },
  });
}

const field = (): HTMLInputElement => screen.getByLabelText('Quick add');
const type = (text: string): void => {
  const el = field();
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
};

describe('QuickAddApp', () => {
  it('hydrates the lists from main', async () => {
    const api = setup();
    render(<QuickAddApp />);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'lists:getAll')).toBe(true));
    expect(api.calls.some((c) => c.channel === 'settings:getAll')).toBe(true);
  });

  it('submits through window:quickAddSubmit and hides on ⏎', async () => {
    const api = setup();
    render(<QuickAddApp />);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'lists:getAll')).toBe(true));
    type('Pay rent tomorrow #work');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'window:quickAddSubmit')).toBe(true));
    const payload = api.calls.find((c) => c.channel === 'window:quickAddSubmit')!.payload as { title: string; listId: string; keepOpen: boolean };
    expect(payload.title).toBe('Pay rent');
    expect(payload.listId).toBe('list-2');
    expect(payload.keepOpen).toBe(false);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'window:hideQuickAdd')).toBe(true));
  });

  it('⇧⏎ keeps the HUD open and flashes the created title', async () => {
    const api = setup();
    render(<QuickAddApp />);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'lists:getAll')).toBe(true));
    type('Water plants');
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added “Water plants”'));
    expect(api.calls.some((c) => c.channel === 'window:hideQuickAdd')).toBe(false);
    expect(field().value).toBe('');
  });

  it('Esc clears, then hides', async () => {
    const api = setup();
    render(<QuickAddApp />);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'lists:getAll')).toBe(true));
    type('Something');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field().value).toBe('');
    expect(api.calls.some((c) => c.channel === 'window:hideQuickAdd')).toBe(false);
    fireEvent.keyDown(field(), { key: 'Escape' });
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'window:hideQuickAdd')).toBe(true));
  });

  it('asks main to resize as chips appear', async () => {
    const api = setup();
    render(<QuickAddApp />);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'lists:getAll')).toBe(true));
    type('Ship it tomorrow');
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'window:resizeQuickAdd')).toBe(true));
  });

  it('keeps a fresh draft when re-shown, and drops a stale one', async () => {
    const api = setup();
    render(<QuickAddApp />);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'lists:getAll')).toBe(true));
    type('Half-typed thought');
    api.emit({ type: 'quickadd:shown' });
    await waitFor(() => expect(field().value).toBe('Half-typed thought'));

    // Simulate a dismissal longer ago than the draft TTL.
    fireEvent.keyDown(field(), { key: 'Escape' });
    fireEvent.keyDown(field(), { key: 'Escape' });
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'window:hideQuickAdd')).toBe(true));
    type('New thought');
    api.emit({ type: 'quickadd:shown' });
    await waitFor(() => expect(field().value).toBe('New thought'));
  });

  it('refreshes lists when data changes', async () => {
    const api = setup();
    render(<QuickAddApp />);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'lists:getAll')).toBe(true));
    const before = api.calls.filter((c) => c.channel === 'lists:getAll').length;
    api.emit({ type: 'data:changed', reason: 'sync', tasks: [], lists: [makeList({ id: 'list-3', title: 'New' })], deletedTaskIds: [], deletedListIds: [] });
    await waitFor(() => expect(api.calls.filter((c) => c.channel === 'lists:getAll').length).toBeGreaterThan(before));
  });

  it('follows a theme change from main', async () => {
    const api = setup();
    render(<QuickAddApp />);
    api.emit({ type: 'theme:changed', resolved: 'dark', preference: 'system' });
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('dark'));
  });

  it('shows an error when the submit fails', async () => {
    const api = setup();
    render(<QuickAddApp />);
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'lists:getAll')).toBe(true));
    api.failNext('window:quickAddSubmit');
    type('Boom');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save that task.'));
  });
});
