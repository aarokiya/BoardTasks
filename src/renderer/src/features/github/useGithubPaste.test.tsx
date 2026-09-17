import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask, type MockApi } from '../../../../../tests/setup/mockApi';
import { renderApp } from '../../../../../tests/setup/render';
import { useStore } from '../../store/store';
import { useGithubPaste } from './useGithubPaste';
import { makeLink } from './testUtils';

function Harness({ field = 'title', initial = '' }: { field?: 'title' | 'notes'; initial?: string }): ReactElement {
  const [value, setValue] = useState(initial);
  const onPaste = useGithubPaste({ taskId: 'task-1', field, value, onChange: setValue });
  return (
    <input
      aria-label="field"
      value={value}
      onChange={(e) => { setValue(e.target.value); }}
      onPaste={onPaste}
    />
  );
}

async function mount(props: { field?: 'title' | 'notes'; initial?: string } = {}): Promise<{ api: MockApi; input: HTMLElement }> {
  const task = makeTask({ id: 'task-1', listId: 'list-1', title: 'Ship it' });
  const { api } = await renderApp(<Harness {...props} />, { seed: { tasks: [task] } });
  const input = screen.getByLabelText('field');
  await userEvent.click(input);
  return { api, input };
}

const linkCall = (api: MockApi): unknown => api.calls.find((c) => c.channel === 'github:link')?.payload;

describe('useGithubPaste', () => {
  it('strips the URL out of pasted prose and links it instead', async () => {
    const { api, input } = await mount({ field: 'notes' });
    await userEvent.paste('please review https://github.com/o/r/pull/8 before Friday');
    await waitFor(() => { expect(linkCall(api)).toBeDefined(); });
    expect(linkCall(api)).toEqual({ taskId: 'task-1', url: 'https://github.com/o/r/pull/8' });
    expect(input).toHaveValue('please review before Friday');
  });

  it('takes the fetched title when the pasted URL was the whole title', async () => {
    const { api, input } = await mount({ field: 'title' });
    await userEvent.paste('https://github.com/o/r/issues/12');
    await waitFor(() => { expect(input).toHaveValue('Issue'); });
    expect(api.calls.find((c) => c.channel === 'tasks:update')?.payload).toMatchObject({ id: 'task-1', patch: { title: 'Issue' } });
    const toast = useStore.getState().toasts.at(-1)!;
    expect(toast.message).toBe('Title taken from GitHub');
    expect(toast.actionLabel).toBe('Undo');
    act(() => { toast.onAction?.(); });
    await waitFor(() => { expect(input).toHaveValue(''); });
  });

  it('waits for enrichment to arrive when the link has no title yet', async () => {
    const { api, input } = await mount({ field: 'title' });
    api.stub('github:link', (p) => makeLink({ taskId: p.taskId, url: p.url, title: null, state: null, fetchedAt: null }));
    await userEvent.paste('o/r#12');
    await waitFor(() => { expect(linkCall(api)).toBeDefined(); });
    expect(input).toHaveValue('');

    act(() => {
      api.emit({
        type: 'data:changed', reason: 'github', lists: [], deletedTaskIds: [], deletedListIds: [],
        tasks: [makeTask({ id: 'task-1', rev: 9, github: makeLink({ taskId: 'task-1', title: 'Fix the flicker' }) })],
      });
    });
    await waitFor(() => { expect(input).toHaveValue('Fix the flicker'); });
  });

  it('keeps a title the user actually typed', async () => {
    const { api, input } = await mount({ field: 'title', initial: 'Review the PR' });
    await userEvent.paste(' https://github.com/o/r/pull/8');
    await waitFor(() => { expect(linkCall(api)).toBeDefined(); });
    expect(input).toHaveValue('Review the PR');
    expect(api.calls.some((c) => c.channel === 'tasks:update')).toBe(false);
  });

  it('leaves non-GitHub pastes completely alone', async () => {
    const { api, input } = await mount({ field: 'notes' });
    await userEvent.paste('https://example.com/o/r/issues/1');
    expect(api.calls.some((c) => c.channel === 'github:link')).toBe(false);
    expect(input).toHaveValue('https://example.com/o/r/issues/1');
  });

  it('says so when the link could not be made', async () => {
    const { api } = await mount({ field: 'notes' });
    api.failNext('github:link');
    await userEvent.paste('https://github.com/o/r/pull/8');
    await waitFor(() => { expect(useStore.getState().toasts.at(-1)?.message).toBe('Could not link o/r#8'); });
  });
});
