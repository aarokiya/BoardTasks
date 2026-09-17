import type { Priority, TaskList } from '@shared/models';
import type { CivilDate } from '@shared/date/civil';

/** Every category the quick-add grammar can pull out of the raw text. */
export type TokenKind = 'date' | 'time' | 'list' | 'priority' | 'flag' | 'notes';

export interface ParsedToken {
  kind: TokenKind;
  /** Offset of the first character of the token in the ORIGINAL input. */
  start: number;
  /** Offset one past the last character, in the ORIGINAL input. */
  end: number;
  /** Exact source slice `input.slice(start, end)`. */
  raw: string;
  /** Human label for the chip: "Tomorrow", "5 PM", "Work", "High", "Flagged". */
  label: string;
}

export type WarningCode = 'unknown-list' | 'past-date' | 'ambiguous-date';

export interface ParseWarning {
  code: WarningCode;
  message: string;
  /** The offending text, e.g. the unresolved list name. */
  value: string;
}

export interface ParseContext {
  /** Today in the user's local calendar. Injected — the parser never reads a clock. */
  today: CivilDate;
  /** "Now", used only for deciding whether a bare time is today or tomorrow. */
  now: Date;
  lists: TaskList[];
  defaultListId: string | null;
  dateOrder: 'MDY' | 'DMY';
}

export interface ParsedQuickAdd {
  title: string;
  notes: string;
  due: CivilDate | null;
  /** 'HH:mm', local-only. */
  dueTime: string | null;
  /** Resolved list, or the context default when no #list was typed. */
  listId: string | null;
  /** Set when a #list could not be resolved, so the UI can offer "create list?". */
  listQuery: string | null;
  priority: Priority;
  flagged: boolean;
  tokens: ParsedToken[];
  warnings: ParseWarning[];
}
