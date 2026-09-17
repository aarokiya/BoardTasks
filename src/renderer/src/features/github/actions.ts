import { call } from '../../lib/ipc';
import { announce } from '../../lib/announce';
import { useStore } from '../../store/store';

/** Opens in the system browser via main — the renderer can never navigate itself. */
export async function openOnGithub(url: string): Promise<void> {
  try {
    await call('app:openExternal', { url });
  } catch {
    useStore.getState().toast({ level: 'error', message: 'Could not open that link.' });
  }
}

export async function copyGithubUrl(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    announce('Link copied');
    useStore.getState().toast({ level: 'success', message: 'Link copied', timeoutMs: 2000 });
  } catch {
    useStore.getState().toast({ level: 'error', message: 'Could not copy the link.' });
  }
}

export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
