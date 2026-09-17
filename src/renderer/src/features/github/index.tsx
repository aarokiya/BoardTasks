import type { ReactElement } from 'react';
import type { GithubLink, Task } from '@shared/models';
/** Owned by the GitHub track. These named exports are the contract other tracks import. */
export function GithubChip(_p: { link: GithubLink; compact?: boolean }): ReactElement | null {
  return null;
}
export function GithubCard(_p: { task: Task }): ReactElement | null {
  return null;
}
export function GithubConnectSettings(): ReactElement | null {
  return null;
}
/** Rendered when store.overlay === 'github-picker'; overlayPayload = { taskId }. */
export function GithubPickerOverlay(): ReactElement | null {
  return null;
}
