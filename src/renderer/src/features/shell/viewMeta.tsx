import type { ReactElement } from 'react';
import type { SmartViewId, ViewId } from '@shared/constants';
import type { TaskList } from '@shared/models';
import { IconAlert, IconCalendar, IconCheckCircle, IconClock, IconGithub, IconInbox, IconSun } from '../../components/icons';

export interface ViewMeta {
  id: SmartViewId;
  title: string;
  icon: ReactElement;
  shortcut: string;
}

export const SMART_VIEW_META: ViewMeta[] = [
  { id: 'today', title: 'Today', icon: <IconSun />, shortcut: '⌘1' },
  { id: 'upcoming', title: 'Upcoming', icon: <IconCalendar />, shortcut: '⌘2' },
  { id: 'overdue', title: 'Overdue', icon: <IconAlert />, shortcut: '⌘3' },
  { id: 'all', title: 'All', icon: <IconInbox />, shortcut: '⌘4' },
  { id: 'nodate', title: 'No Date', icon: <IconClock />, shortcut: '⌘5' },
  { id: 'github', title: 'GitHub', icon: <IconGithub />, shortcut: '⌘6' },
  { id: 'completed', title: 'Completed', icon: <IconCheckCircle />, shortcut: '⌘7' },
];

export function viewTitle(view: ViewId, lists: TaskList[]): string {
  if (view.startsWith('list:')) {
    const id = view.slice(5);
    return lists.find((l) => l.id === id)?.title ?? 'List';
  }
  return SMART_VIEW_META.find((m) => m.id === view)?.title ?? 'Tasks';
}
