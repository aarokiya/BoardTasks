import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TimePicker, TimePickerOverlay } from '../../../src/renderer/src/features/quickadd/TimePicker';
import { useStore } from '../../../src/renderer/src/store/store';
import { installMockApi, makeList, makeTask, type MockApi } from '../../setup/mockApi';

async function setup(): Promise<MockApi> {
  const api = installMockApi({
    lists: [makeList({ id: 'list-1', title: 'Inbox', isDefault: true })],
    tasks: [makeTask({ id: 't1', title: 'One', listId: 'list-1' })],
  });
  useStore.setState({ tasks: {}, lists: {}, overlay: null, undoPast: [], undoFuture: [] });
  await useStore.getState().hydrate();
  return api;
}

beforeEach(() => {
  useStore.setState({ overlay: null });
});

describe('TimePicker', () => {
  it('accepts a natural-language time', () => {
    const onPick = vi.fn();
    render(<TimePicker value={null} onPick={onPick} onClose={vi.fn()} />);
    const field = screen.getByLabelText('Time');
    fireEvent.change(field, { target: { value: '5pm' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('17:00');
  });

  it('accepts a 24-hour time', () => {
    const onPick = vi.fn();
    render(<TimePicker value={null} onPick={onPick} onClose={vi.fn()} />);
    const field = screen.getByLabelText('Time');
    fireEvent.change(field, { target: { value: '17:30' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('17:30');
  });

  it('rejects nonsense with a hint', () => {
    const onPick = vi.fn();
    render(<TimePicker value={null} onPick={onPick} onClose={vi.fn()} />);
    const field = screen.getByLabelText('Time');
    fireEvent.change(field, { target: { value: 'half past' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears on an empty commit', () => {
    const onPick = vi.fn();
    render(<TimePicker value="17:00" onPick={onPick} onClose={vi.fn()} />);
    const field = screen.getByLabelText('Time');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('picks a preset', () => {
    const onPick = vi.fn();
    render(<TimePicker value={null} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('9 AM'));
    expect(onPick).toHaveBeenCalledWith('09:00');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<TimePicker value={null} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Reminder time' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('TimePickerOverlay', () => {
  it('renders nothing when the overlay is closed', async () => {
    await setup();
    const { container } = render(<TimePickerOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('applies the time to every target task and records undo', async () => {
    await setup();
    useStore.getState().openOverlay('time-picker', { taskIds: ['t1'] });
    render(<TimePickerOverlay />);
    fireEvent.click(screen.getByText('9 AM'));
    await waitFor(() => expect(useStore.getState().tasks['t1']?.dueTime).toBe('09:00'));
    expect(useStore.getState().overlay).toBeNull();
    await useStore.getState().undo();
    await waitFor(() => expect(useStore.getState().tasks['t1']?.dueTime).toBeNull());
  });

  it('ignores a payload with no task ids', async () => {
    await setup();
    useStore.getState().openOverlay('time-picker', {});
    const { container } = render(<TimePickerOverlay />);
    expect(container).toBeEmptyDOMElement();
  });
});
