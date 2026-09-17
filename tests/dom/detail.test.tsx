import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { todayCivil } from '@shared/date/civil';
import { renderApp } from '../setup/render';
import { useStore } from '../../src/renderer/src/store/store';
import { DetailPane } from '../../src/renderer/src/features/detail';

const today = todayCivil();

const conflict = {
  fields: ['title'],
  server: { title: 'Their title' },
  remoteDeleted: false,
  detectedAt: new Date().toISOString(),
};

describe('DetailPane', () => {
  it('shows a placeholder when nothing is selected', async () => {
    await renderApp(<DetailPane />, { view: 'list:l1', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    expect(screen.getByText('No task selected')).toBeInTheDocument();
  });

  it('renders the focused task and commits a title edit', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<DetailPane />, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Draft' }] },
    });
    act(() => useStore.getState().select(['t1'], 't1'));
    const title = await screen.findByLabelText('Task title');
    await user.clear(title);
    await user.type(title, 'Final{Enter}');
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'tasks:update' && JSON.stringify(c.payload).includes('Final'))).toBe(true));
  });

  it('edits notes through the store', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<DetailPane />, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Draft' }] },
    });
    act(() => useStore.getState().select(['t1'], 't1'));
    const notes = await screen.findByRole('textbox', { name: 'Notes' });
    await user.click(notes);
    await user.type(notes, 'Some detail');
    await user.tab();
    await waitFor(() => expect(api.calls.some((c) => c.channel === 'tasks:update' && JSON.stringify(c.payload).includes('Some detail'))).toBe(true));
  });

  it('shows the conflict banner with both versions and keeps mine', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<DetailPane />, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [{ id: 't1', listId: 'l1', title: 'My title', sync: 'conflict', conflict }],
      },
    });
    act(() => useStore.getState().select(['t1'], 't1'));
    const banner = await screen.findByRole('region', { name: 'Sync conflict' });
    expect(within(banner).getByText('Their title')).toBeInTheDocument();
    expect(within(banner).getByText('My title')).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Keep mine' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'tasks:resolveConflict' && (c.payload as { resolution: string }).resolution === 'keepLocal')).toBe(true),
    );
  });

  it('resolves a conflict with the server version', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<DetailPane />, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [{ id: 't1', listId: 'l1', title: 'My title', sync: 'conflict', conflict }],
      },
    });
    act(() => useStore.getState().select(['t1'], 't1'));
    await user.click(await screen.findByRole('button', { name: 'Use theirs' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'tasks:resolveConflict' && (c.payload as { resolution: string }).resolution === 'useServer')).toBe(true),
    );
  });

  it('offers Restore and Discard when the server deleted the task', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(<DetailPane />, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [
          {
            id: 't1', listId: 'l1', title: 'Gone remotely', sync: 'conflict',
            conflict: { fields: [], server: {}, remoteDeleted: true, detectedAt: new Date().toISOString() },
          },
        ],
      },
    });
    act(() => useStore.getState().select(['t1'], 't1'));
    const banner = await screen.findByRole('region', { name: 'Sync conflict' });
    expect(within(banner).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.channel === 'tasks:resolveConflict' && (c.payload as { resolution: string }).resolution === 'discard')).toBe(true),
    );
  });

  it('switches to bulk actions for a multi-selection', async () => {
    await renderApp(<DetailPane />, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [{ id: 't1', listId: 'l1', title: 'A' }, { id: 't2', listId: 'l1', title: 'B' }],
      },
    });
    act(() => useStore.getState().select(['t1', 't2'], 't1'));
    expect(await screen.findByText(/2 tasks selected/i)).toBeInTheDocument();
  });

  it('offers a due date field that opens the date picker', async () => {
    const user = userEvent.setup();
    await renderApp(<DetailPane />, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'A', due: today }] },
    });
    act(() => useStore.getState().select(['t1'], 't1'));
    await user.click(await screen.findByRole('button', { name: 'Due' }));
    const picker = await screen.findByRole('dialog', { name: 'Choose a due date' });
    expect(within(picker).getByRole('grid')).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: /^Tomorrow/ })).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: /^Clear/ })).toBeInTheDocument();
  });
});
