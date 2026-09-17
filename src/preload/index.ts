import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type Channel, type Req } from '../shared/ipc';
import { MAIN_EVENT_CHANNEL, type MainEvent } from '../shared/events';

const allow = new Set<string>(CHANNELS);

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const api = {
  invoke: (channel: Channel, payload?: Req<Channel>): Promise<unknown> => {
    if (!allow.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload ?? null);
  },
  onEvent: (cb: (e: MainEvent) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, e: MainEvent): void => cb(e);
    ipcRenderer.on(MAIN_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(MAIN_EVENT_CHANNEL, listener);
  },
  /** Resolved at document-start from additionalArguments — zero IPC round trips before first paint. */
  boot: {
    window: (arg('bt-window') ?? 'main') as 'main' | 'quickadd',
    theme: (arg('bt-theme') ?? 'light') as 'light' | 'dark',
    themePreference: (arg('bt-theme-pref') ?? 'system') as 'light' | 'dark' | 'system',
    platform: process.platform as string,
    e2e: arg('bt-e2e') === '1',
  },
} as const;

contextBridge.exposeInMainWorld('boardtasks', api);
export type BoardTasksBridge = typeof api;
