import { announce } from '../../lib/announce';
import { useStore } from '../../store/store';
import type { CommandId } from '../ids';
import type { CommandImpl } from '../registry';

export const editCommands: Partial<Record<CommandId, CommandImpl>> = {
  'edit.undo': {
    enabled: () => useStore.getState().undoPast.length > 0,
    run: async () => {
      const s = useStore.getState();
      const entry = s.undoPast[s.undoPast.length - 1];
      if (!entry) return;
      await s.undo();
      useStore.getState().toast({ level: 'info', message: `Undid: ${entry.label}`, actionLabel: 'Redo', onAction: () => void useStore.getState().redo() });
      announce(`Undid ${entry.label}`);
    },
  },
  'edit.redo': {
    enabled: () => useStore.getState().undoFuture.length > 0,
    run: async () => {
      const s = useStore.getState();
      const entry = s.undoFuture[s.undoFuture.length - 1];
      if (!entry) return;
      await s.redo();
      useStore.getState().toast({ level: 'info', message: `Redid: ${entry.label}` });
      announce(`Redid ${entry.label}`);
    },
  },
};
