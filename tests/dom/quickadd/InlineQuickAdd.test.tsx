import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TaskCreateInput } from '../../../src/shared/models';
import { InlineQuickAdd } from '../../../src/renderer/src/features/quickadd/InlineQuickAdd';
import { useStore } from '../../../src/renderer/src/store/store';
import { installMockApi, makeList, type MockApi } from '../../setup/mockApi';

async function setup(): Promise<MockApi> {
  const api = installMockApi({
    lists: [makeList({ id: 'list-1', title: 'Inbox', isDefault: true }), makeList({ id: 'list-2', title: 'Work', isDefault: false })],
  });
  useStore.setState({ tasks: {}, lists: {}, selection: [], focusId: null, overlay: null, undoPast: [], undoFuture: [] });
  await useStore.getState().hydrate();
  const live = document.createElement('div');
  live.innerHTML = '<div id="bt-status" role="status" aria-live="polite"></div>';
  document.body.appendChild(live);
  return api;
}

const field = (): HTMLInputElement => screen.getByLabelText('Quick add');
const type = (text: string): void => {
  const el = field();
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
};
const created = (api: MockApi): TaskCreateInput[] => api.calls.filter((c) => c.channel === 'tasks:create').map((c) => c.payload as TaskCreateInput);

beforeEach(() => {
  useStore.setState({ overlay: null });
});

describe('InlineQuickAdd', () => {
  it('renders an empty row with a placeholder', async () => {
    await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    expect(screen.getByTestId('inline-quick-add')).toBeInTheDocument();
    expect(screen.queryByTestId('quickadd-chips')).not.toBeInTheDocument();
  });

  it('autofocuses the input', async () => {
    await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it('renders a chip per parsed token', async () => {
    await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Review specs tomorrow 4pm #work !1 *');
    const chips = screen.getByTestId('quickadd-chips');
    expect(chips).toHaveTextContent('Tomorrow');
    expect(chips).toHaveTextContent('4 PM');
    expect(chips).toHaveTextContent('Work');
    expect(chips).toHaveTextContent('High');
    expect(chips).toHaveTextContent('Flagged');
  });

  it('highlights the token spans in the mirror', async () => {
    await setup();
    const { container } = render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Ship it tomorrow');
    const marked = container.querySelectorAll('[class*="tok"]');
    expect(marked.length).toBeGreaterThan(0);
    expect([...marked].map((m) => m.textContent)).toContain('tomorrow');
  });

  it('Enter creates the task with the parsed fields and stays open', async () => {
    const api = await setup();
    const onDone = vi.fn();
    render(<InlineQuickAdd listId="list-1" onDone={onDone} />);
    type('Review specs tomorrow 4pm #work !1 *');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(created(api)).toHaveLength(1));
    const input = created(api)[0]!;
    expect(input.title).toBe('Review specs');
    expect(input.dueTime).toBe('16:00');
    expect(input.priority).toBe(1);
    expect(input.flagged).toBe(true);
    expect(input.listId).toBe('list-2');
    expect(onDone).not.toHaveBeenCalled();
    await waitFor(() => expect(field().value).toBe(''));
  });

  it('⇧Enter creates and closes the row', async () => {
    const api = await setup();
    const onDone = vi.fn();
    render(<InlineQuickAdd listId="list-1" onDone={onDone} />);
    type('Buy milk');
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(created(api)).toHaveLength(1));
    expect(onDone).toHaveBeenCalled();
  });

  it('creates subtasks at the end of the parent', async () => {
    const api = await setup();
    render(<InlineQuickAdd listId="list-1" parentId="p1" onDone={vi.fn()} />);
    type('Sub one');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(created(api)).toHaveLength(1));
    expect(created(api)[0]!.parentId).toBe('p1');
    expect(created(api)[0]!.previousId).toBe('end');
  });

  it('announces the creation', async () => {
    const api = await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Buy milk');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(created(api)).toHaveLength(1));
    await waitFor(() => expect(document.getElementById('bt-status')?.textContent).toContain('Task created'));
  });

  it('does not create anything when the title is empty', async () => {
    const api = await setup();
    const onDone = vi.fn();
    render(<InlineQuickAdd listId="list-1" onDone={onDone} />);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(created(api)).toHaveLength(0);
    expect(onDone).toHaveBeenCalled();
  });

  it('Esc clears first, then closes', async () => {
    await setup();
    const onDone = vi.fn();
    render(<InlineQuickAdd listId="list-1" onDone={onDone} />);
    type('Buy milk');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field().value).toBe('');
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(onDone).toHaveBeenCalled();
  });

  it('Backspace on an empty row closes it', async () => {
    await setup();
    const onDone = vi.fn();
    render(<InlineQuickAdd listId="list-1" onDone={onDone} />);
    fireEvent.keyDown(field(), { key: 'Backspace' });
    expect(onDone).toHaveBeenCalled();
  });

  it('Backspace at the end removes the whole trailing chip', async () => {
    await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Ship it tomorrow');
    expect(screen.getByTestId('quickadd-chips')).toHaveTextContent('Tomorrow');
    fireEvent.keyDown(field(), { key: 'Backspace' });
    expect(field().value.trim()).toBe('Ship it');
    expect(screen.queryByTestId('quickadd-chips')).not.toBeInTheDocument();
  });

  it('shows a create-list warning chip for an unknown list', async () => {
    await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Buy milk #groceries');
    expect(screen.getByTestId('quickadd-unknown-list')).toHaveTextContent('Create list “groceries”?');
  });

  it('creates the missing list before the task', async () => {
    const api = await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Buy milk #groceries');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(created(api)).toHaveLength(1));
    const listCreate = api.calls.find((c) => c.channel === 'lists:create');
    expect(listCreate?.payload).toEqual({ title: 'groceries' });
    const newList = [...api.state.lists.values()].find((l) => l.title === 'groceries')!;
    expect(created(api)[0]!.listId).toBe(newList.id);
  });

  it('clicking the list chip opens the list menu', async () => {
    await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Buy milk #work');
    fireEvent.click(screen.getByLabelText('List Work'));
    const menu = screen.getByRole('menu', { name: 'Move to list' });
    fireEvent.click(within(menu).getByText('Inbox'));
    expect(field().value).toContain('#Inbox');
  });

  it('clicking the priority chip removes it', async () => {
    await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Fix prod !1');
    fireEvent.click(screen.getByLabelText(/Priority High/));
    expect(field().value.trim()).toBe('Fix prod');
  });

  it('clicking the date chip opens a calendar and picking rewrites the text', async () => {
    await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Ship it tomorrow');
    fireEvent.click(screen.getByLabelText('Due Tomorrow'));
    const dialog = screen.getByRole('dialog', { name: 'Due date' });
    fireEvent.click(within(dialog).getByText('Today'));
    expect(field().value).toContain(useStore.getState().today);
  });

  it('surfaces a failure as a toast', async () => {
    const api = await setup();
    api.failNext('tasks:create');
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('Buy milk');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(useStore.getState().toasts.map((t) => t.message)).toContain('Could not create the task'));
  });

  it('ignores Enter during IME composition', async () => {
    const api = await setup();
    render(<InlineQuickAdd listId="list-1" onDone={vi.fn()} />);
    type('日本語');
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(created(api)).toHaveLength(0);
  });
});
