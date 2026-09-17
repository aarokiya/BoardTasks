import type { ReactElement } from 'react';
import { useStore } from '../store/store';
import { CommandPalette } from '../features/palette/CommandPalette';
import { ShortcutsOverlay } from '../features/shortcuts/ShortcutsOverlay';
import { GithubPickerOverlay } from '../features/github';
import { SettingsPanel } from '../features/settings/SettingsPanel';
import { OutboxSheet } from '../features/outbox/OutboxSheet';
import { Onboarding } from '../features/onboarding/Onboarding';
import { DatePickerOverlay, ListPickerOverlay } from '../features/detail';
import { ErrorBoundary } from '../components/ErrorBoundary';

export interface OverlaysProps {
  /** Forces the onboarding wizard regardless of store.overlay. */
  forceOnboarding: boolean;
}

export function Overlays({ forceOnboarding }: OverlaysProps): ReactElement | null {
  const overlay = useStore((st) => st.overlay);

  if (forceOnboarding || overlay === 'onboarding') {
    return (
      <ErrorBoundary level="pane" name="Setup">
        <Onboarding />
      </ErrorBoundary>
    );
  }

  switch (overlay) {
    case 'palette':
      return <ErrorBoundary level="pane" name="Command palette"><CommandPalette /></ErrorBoundary>;
    case 'shortcuts':
      return <ErrorBoundary level="pane" name="Keyboard shortcuts"><ShortcutsOverlay /></ErrorBoundary>;
    case 'settings':
      return <ErrorBoundary level="pane" name="Settings"><SettingsPanel /></ErrorBoundary>;
    case 'outbox':
      return <ErrorBoundary level="pane" name="Unsynced changes"><OutboxSheet /></ErrorBoundary>;
    case 'github-picker':
      return <ErrorBoundary level="pane" name="GitHub picker"><GithubPickerOverlay /></ErrorBoundary>;
    case 'list-picker':
      return <ErrorBoundary level="pane" name="List picker"><ListPickerOverlay /></ErrorBoundary>;
    case 'date-picker':
    case 'time-picker':
      return <ErrorBoundary level="pane" name="Date picker"><DatePickerOverlay /></ErrorBoundary>;
    default:
      return null;
  }
}
