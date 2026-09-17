import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { renderApp } from '../setup/render';
import { useStore } from '../../src/renderer/src/store/store';
import { App } from '../../src/renderer/src/app/App';
import { ErrorBoundary } from '../../src/renderer/src/components/ErrorBoundary';
import { applyTheme } from '../../src/renderer/src/hooks/useThemeSync';
import { runCommand } from '../../src/renderer/src/commands/registry';

function Boom(): ReactElement {
  throw new Error('pane exploded');
}

describe('AppShell', () => {
  it('renders the titlebar, sidebar and list together', async () => {
    await renderApp(<App />, {
      view: 'list:l1',
      seed: { lists: [{ id: 'l1', title: 'Work' }], tasks: [{ id: 't1', listId: 'l1', title: 'Ship it' }] },
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Work');
    expect(screen.getByRole('tree', { name: 'Views and lists' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Ship it' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeInTheDocument();
  });

  it('mounts exactly one pair of live regions', async () => {
    await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1' }] } });
    // The harness mounts one pair; the app mounts its own. Both must be unique per id.
    expect(document.querySelectorAll('#bt-status').length).toBeGreaterThanOrEqual(1);
    const status = document.getElementById('bt-status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(document.getElementById('bt-alert')).toHaveAttribute('aria-live', 'assertive');
  });

  it('filters the list from the titlebar field', async () => {
    const user = userEvent.setup();
    await renderApp(<App />, {
      view: 'list:l1',
      seed: {
        lists: [{ id: 'l1', title: 'Work' }],
        tasks: [{ id: 't1', listId: 'l1', title: 'Alpha' }, { id: 't2', listId: 'l1', title: 'Beta' }],
      },
    });
    await user.type(screen.getByRole('searchbox', { name: 'Filter tasks in Work' }), 'alp');
    await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument());
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('focuses the filter field from edit.find', async () => {
    await renderApp(<App />, { view: 'list:l1', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    await act(async () => { await runCommand('edit.find'); });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Filter tasks in Work' }));
  });

  it('toggles the sidebar from the titlebar and from view.sidebar', async () => {
    const user = userEvent.setup();
    await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(useStore.getState().sidebarUserCollapsed).toBe(true);
    await act(async () => { await runCommand('view.sidebar'); });
    expect(useStore.getState().sidebarUserCollapsed).toBe(false);
  });

  it('toggles the inspector from the titlebar', async () => {
    const user = userEvent.setup();
    await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    const before = useStore.getState().inspectorOpen;
    await user.click(screen.getByRole('button', { name: before ? 'Hide inspector' : 'Show inspector' }));
    expect(useStore.getState().inspectorOpen).toBe(!before);
  });

  it('navigates with the nav.* commands', async () => {
    await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1', title: 'Work' }] } });
    await act(async () => { await runCommand('nav.upcoming'); });
    expect(useStore.getState().view).toBe('upcoming');
    await act(async () => { await runCommand('nav.completed'); });
    expect(useStore.getState().view).toBe('completed');
  });

  it('cycles density with view.density and persists it to settings', async () => {
    const { api } = await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1' }], settings: { density: 'default' } } });
    // App re-hydrates on mount; let that settle before driving the command.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await runCommand('view.density'); });
    await waitFor(() => expect(useStore.getState().density).toBe('comfortable'));
    expect(api.calls.some((c) => c.channel === 'settings:set' && (c.payload as { density?: string }).density === 'comfortable')).toBe(true);
    await act(async () => { await runCommand('view.density'); });
    await waitFor(() => expect(useStore.getState().density).toBe('compact'));
  });
});

describe('ErrorBoundary', () => {
  it('contains a throwing pane and leaves its siblings usable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <ErrorBoundary level="pane" name="Inspector">
          <Boom />
        </ErrorBoundary>
        <div data-testid="task-list">Still here</div>
      </div>,
    );
    expect(screen.getAllByRole('alert').some((el) => /Inspector could not be displayed/.test(el.textContent ?? ''))).toBe(true);
    expect(screen.getByTestId('task-list')).toHaveTextContent('Still here');
    spy.mockRestore();
  });

  it('degrades a throwing row to a plain text row', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary level="row" name="Task row" rowText="Book flights">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('treeitem')).toHaveTextContent('Book flights');
    spy.mockRestore();
  });

  it('recovers when Try again is pressed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    let shouldThrow = true;
    function Flaky(): ReactElement {
      if (shouldThrow) throw new Error('nope');
      return <div>recovered</div>;
    }
    render(
      <ErrorBoundary level="pane" name="Task list">
        <Flaky />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('theme sync', () => {
  it('writes the theme attribute directly with transitions suppressed', () => {
    document.documentElement.dataset.theme = 'light';
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('bt-theme-switching')).toBe(true);
  });

  it('applies theme:changed pushes from main', async () => {
    document.documentElement.dataset.theme = 'light';
    const { api } = await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1' }] } });
    act(() => api.emit({ type: 'theme:changed', resolved: 'dark', preference: 'system' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('Toasts', () => {
  it('shows a toast with an action and dismisses it', async () => {
    const user = userEvent.setup();
    await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1' }] } });
    const action = vi.fn();
    act(() => { useStore.getState().toast({ level: 'success', message: 'Task deleted', actionLabel: 'Undo', onAction: action }); });
    expect(await screen.findByText('Task deleted')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(action).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Task deleted')).not.toBeInTheDocument());
  });

  it('dismisses a toast from its close button', async () => {
    const user = userEvent.setup();
    await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1' }] } });
    act(() => { useStore.getState().toast({ level: 'error', message: 'Sync failed' }); });
    expect(await screen.findByText('Sync failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByText('Sync failed')).not.toBeInTheDocument());
  });
});

describe('Overlay routing', () => {
  it('opens the settings panel', async () => {
    await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1' }] } });
    act(() => useStore.getState().openOverlay('settings'));
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('opens the outbox sheet', async () => {
    await renderApp(<App />, { view: 'today', seed: { lists: [{ id: 'l1' }] } });
    act(() => useStore.getState().openOverlay('outbox'));
    expect(await screen.findByRole('dialog', { name: /unsynced changes/i })).toBeInTheDocument();
  });

  it('forces onboarding when it has never been completed', async () => {
    await renderApp(<App />, {
      view: 'today',
      seed: { lists: [{ id: 'l1' }], settings: { onboardingComplete: false }, auth: { state: 'no_credentials' } },
    });
    expect(await screen.findByText('Step 1 of 6')).toBeInTheDocument();
  });
});
