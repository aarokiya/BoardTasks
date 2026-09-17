import type { Channel, Req } from '../shared/ipc';
import type { MainEvent } from '../shared/events';

export interface BoardTasksBridge {
  invoke(channel: Channel, payload?: Req<Channel>): Promise<unknown>;
  onEvent(cb: (e: MainEvent) => void): () => void;
  boot: {
    window: 'main' | 'quickadd';
    theme: 'light' | 'dark';
    themePreference: 'light' | 'dark' | 'system';
    platform: string;
    e2e: boolean;
  };
}
