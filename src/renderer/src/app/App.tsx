import { useEffect, useState, type ReactElement } from 'react';
import { boot } from '../lib/ipc';
import { connectStoreToMain, useStore } from '../store/store';
import { useTodayTick } from '../hooks/useTodayTick';
import { applyTheme, useThemeSync } from '../hooks/useThemeSync';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { KeyboardScope } from '../features/shortcuts/KeyboardScope';
import { QuickAddApp } from '../features/quickadd/QuickAddApp';
import { AppShell } from '../features/shell/AppShell';
import { registerShellCommands } from '../features/shell/commands';
import { LiveRegions } from './LiveRegions';
import { Overlays } from './Overlays';
import { Toaster } from './Toaster';

registerShellCommands();

function MainWindow(): ReactElement {
  const hydrated = useStore((st) => st.hydrated);
  const settings = useStore((st) => st.settings);
  const authState = useStore((st) => st.auth?.state ?? null);
  const hydrate = useStore((st) => st.hydrate);
  const toast = useStore((st) => st.toast);
  const [hydrateFailed, setHydrateFailed] = useState(false);

  useTodayTick();
  useThemeSync();

  useEffect(() => {
    const disconnect = connectStoreToMain();
    return disconnect;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void hydrate().catch(() => {
      if (!cancelled) setHydrateFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  useEffect(() => {
    if (!hydrateFailed) return;
    toast({
      level: 'error',
      message: "Couldn't load your tasks from this Mac.",
      actionLabel: 'Retry',
      onAction: () => {
        setHydrateFailed(false);
        void hydrate();
      },
      timeoutMs: 0,
    });
  }, [hydrateFailed, toast, hydrate]);

  const needsOnboarding =
    hydrated && (authState === 'no_credentials' || (settings !== null && !settings.onboardingComplete));

  return (
    <KeyboardScope>
      <ErrorBoundary level="app" name="BoardTasks">
        <AppShell />
      </ErrorBoundary>
      <Overlays forceOnboarding={needsOnboarding} />
      <Toaster />
    </KeyboardScope>
  );
}

export function App(): ReactElement {
  const [window_] = useState(() => {
    try {
      const b = boot();
      applyTheme(b.theme);
      return b.window;
    } catch {
      return 'main' as const;
    }
  });

  return (
    <>
      <LiveRegions />
      {window_ === 'quickadd' ? <QuickAddApp /> : <MainWindow />}
    </>
  );
}
