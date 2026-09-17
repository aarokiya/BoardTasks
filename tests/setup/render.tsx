import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { installMockApi, type MockApi, type MockSeed } from './mockApi';
import { useStore } from '../../src/renderer/src/store/store';

export interface RenderOpts {
  seed?: MockSeed;
  view?: string;
}

/** Installs a mock bridge, hydrates the store, mounts live regions, renders. */
export async function renderApp(ui: ReactElement, opts: RenderOpts = {}): Promise<RenderResult & { api: MockApi }> {
  const api = installMockApi(opts.seed);
  useStore.setState({ tasks: {}, lists: {}, selection: [], focusId: null, overlay: null, toasts: [], undoPast: [], undoFuture: [] });
  await useStore.getState().hydrate();
  if (opts.view) useStore.getState().setView(opts.view as never);
  api.onEvent((e) => useStore.getState().applyEvent(e));
  const live = document.createElement('div');
  live.innerHTML = '<div id="bt-status" role="status" aria-live="polite"></div><div id="bt-alert" role="alert" aria-live="assertive"></div>';
  document.body.appendChild(live);
  const result = render(ui);
  return Object.assign(result, { api });
}
