import { COMMANDS, type CommandId, type CommandMeta } from './ids';
import { useStore, type Store } from '../store/store';

export interface CommandContext {
  store: Store;
  /** Selected task ids (may be empty). */
  selection: string[];
  focusId: string | null;
}

export interface CommandImpl {
  enabled?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, arg?: unknown) => void | Promise<void>;
}

const impls = new Map<CommandId, CommandImpl>();

export function registerCommand(id: CommandId, impl: CommandImpl): void {
  impls.set(id, impl);
}

export function registerCommands(map: Partial<Record<CommandId, CommandImpl>>): void {
  for (const [id, impl] of Object.entries(map)) if (impl) impls.set(id as CommandId, impl);
}

function ctx(): CommandContext {
  const store = useStore.getState();
  return { store, selection: store.selection, focusId: store.focusId };
}

export function isCommandEnabled(id: CommandId): boolean {
  const impl = impls.get(id);
  if (!impl) return false;
  return impl.enabled ? impl.enabled(ctx()) : true;
}

export async function runCommand(id: CommandId, arg?: unknown): Promise<boolean> {
  const impl = impls.get(id);
  if (!impl) return false;
  const c = ctx();
  if (impl.enabled && !impl.enabled(c)) return false;
  await impl.run(c, arg);
  return true;
}

export function listCommands(): Array<CommandMeta & { enabled: boolean }> {
  return COMMANDS.map((c) => ({ ...c, enabled: isCommandEnabled(c.id) }));
}

/** Commands can also be dispatched by name from anywhere (toasts, main-process menu events). */
if (typeof window !== 'undefined') {
  window.addEventListener('bt:command', (e) => {
    const id = (e as CustomEvent<string>).detail as CommandId;
    void runCommand(id);
  });
}
