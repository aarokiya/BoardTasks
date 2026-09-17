import { useMemo } from 'react';
import type { TaskList } from '@shared/models';
import type { CivilDate } from '@shared/date/civil';
import { parseQuickAdd, type ParsedQuickAdd } from './parse';

export interface QuickAddParseOptions {
  lists: TaskList[];
  defaultListId: string | null;
  today: CivilDate;
  dateOrder: 'MDY' | 'DMY';
}

/**
 * Memoized parse. `now` is re-sampled whenever the text changes, which keeps
 * `parseQuickAdd` itself pure while still resolving "5pm" against the real clock.
 */
export function useQuickAddParse(value: string, opts: QuickAddParseOptions): ParsedQuickAdd {
  const { lists, defaultListId, today, dateOrder } = opts;
  return useMemo(
    () => parseQuickAdd(value, { today, now: new Date(), lists, defaultListId, dateOrder }),
    [value, today, lists, defaultListId, dateOrder],
  );
}
