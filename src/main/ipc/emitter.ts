import { BrowserWindow } from 'electron';
import { MAIN_EVENT_CHANNEL, type MainEvent } from '@shared/events';
import type { Task, TaskList } from '@shared/models';

type DataChanged = Extract<MainEvent, { type: 'data:changed' }>;

let pending: DataChanged | null = null;
let timer: NodeJS.Timeout | null = null;

function broadcast(event: MainEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(MAIN_EVENT_CHANNEL, event);
  }
}

/** Send a push event to every window. `data:changed` is coalesced for 50ms and id-deduplicated. */
export function emit(event: MainEvent): void {
  if (event.type !== 'data:changed') return broadcast(event);
  if (!pending) {
    pending = { ...event, tasks: [...event.tasks], lists: [...event.lists], deletedTaskIds: [...event.deletedTaskIds], deletedListIds: [...event.deletedListIds] };
  } else {
    mergeInto(pending.tasks, event.tasks);
    mergeInto(pending.lists, event.lists);
    pending.deletedTaskIds.push(...event.deletedTaskIds);
    pending.deletedListIds.push(...event.deletedListIds);
    if (event.reason === 'conflict') pending.reason = 'conflict';
  }
  if (!timer) {
    timer = setTimeout(() => {
      const ev = pending;
      pending = null;
      timer = null;
      if (ev) {
        ev.deletedTaskIds = [...new Set(ev.deletedTaskIds)];
        ev.deletedListIds = [...new Set(ev.deletedListIds)];
        broadcast(ev);
      }
    }, 50);
  }
}

function mergeInto<T extends Task | TaskList>(target: T[], incoming: T[]): void {
  for (const item of incoming) {
    const i = target.findIndex((t) => t.id === item.id);
    if (i >= 0) {
      if (item.rev >= target[i]!.rev) target[i] = item;
    } else target.push(item);
  }
}

export const emitDataChanged = (partial: Partial<Omit<DataChanged, 'type'>> & { reason: DataChanged['reason'] }): void =>
  emit({ type: 'data:changed', tasks: [], lists: [], deletedTaskIds: [], deletedListIds: [], ...partial });

export function flushEmitter(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    const ev = pending;
    pending = null;
    if (ev) broadcast(ev);
  }
}
