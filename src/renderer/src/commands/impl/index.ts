/**
 * Command bodies for every id in COMMANDS except the ones the shell track owns
 * (view.sidebar, view.inspector, nav.*, edit.find, edit.selectAll, task.expand,
 * view.showCompleted, view.density) — those register themselves from the
 * components that hold the state they need.
 *
 * `registerAllCommands()` is idempotent; KeyboardScope calls it at module load
 * so shortcuts work even before App.tsx gets a chance to.
 */
import type { CommandId } from '../ids';
import { registerCommands } from '../registry';
import { appCommands, githubCommands, syncCommands, viewCommands } from './app';
import { createCommands } from './create';
import { editCommands } from './edit';
import { taskCommands } from './task';

const ALL = {
  ...createCommands,
  ...taskCommands,
  ...editCommands,
  ...viewCommands,
  ...syncCommands,
  ...githubCommands,
  ...appCommands,
};

/** Exactly the ids this track owns — the shell track registers the rest. */
export const REGISTERED_COMMAND_IDS: CommandId[] = Object.keys(ALL) as CommandId[];

let registered = false;

export function registerAllCommands(): void {
  if (registered) return;
  registered = true;
  registerCommands(ALL);
}

export { addTargetListId, subtaskParentId } from './create';
export { nextWeekDate, weekendDate } from './task';
export { targetIds, targetTasks } from './helpers';
