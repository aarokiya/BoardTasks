import { net, powerMonitor } from 'electron';
import type { FetchLike } from '../api/http-client';
import type { NetworkPlatform } from './network-monitor';

/**
 * The only module in src/main/sync that imports `electron`. Keeping it alone
 * here is what lets the whole engine be unit-tested in a plain node
 * environment without mocking Electron.
 *
 * `net.fetch`, not global `fetch`: it routes through Chromium's network stack,
 * so system proxies, PAC scripts and enterprise CA roots work.
 */
export const electronFetch: FetchLike = (url, init) => net.fetch(url, init);

export function createElectronNetworkPlatform(): NetworkPlatform {
  return {
    isOnline: () => {
      try {
        return net.isOnline();
      } catch {
        return true; // negative signal only; never strand the engine offline
      }
    },
    onPower: (handler) => {
      const onSuspend = (): void => handler('suspend');
      const onResume = (): void => handler('resume');
      powerMonitor.on('suspend', onSuspend);
      powerMonitor.on('resume', onResume);
      return () => {
        powerMonitor.off('suspend', onSuspend);
        powerMonitor.off('resume', onResume);
      };
    },
  };
}

export function isOnBatteryPower(): boolean {
  try {
    return powerMonitor.isOnBatteryPower();
  } catch {
    return false;
  }
}
