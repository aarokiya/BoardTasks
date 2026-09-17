import { useEffect, useState, type ReactElement } from 'react';
import type { AppInfo } from '@shared/models';
import { call } from '../lib/ipc';

/** Phase-0 placeholder. Replaced by the UI track. */
export function App(): ReactElement {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void call('app:getInfo').then(setInfo).catch(() => setInfo(null));
  }, []);
  return (
    <div style={{ padding: 40, fontFamily: 'var(--bt-font-sans)' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>BoardTasks</h1>
      <p style={{ color: 'var(--bt-text-secondary)' }}>{info ? `v${info.version} · Electron ${info.electron} · ${info.isPackaged ? 'packaged' : 'dev'}` : 'Loading…'}</p>
    </div>
  );
}
