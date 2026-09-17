import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type RefObject } from 'react';
import type { TaskList } from '@shared/models';
import type { CivilDate } from '@shared/date/civil';
import { DatePickerPopover } from './DatePickerPopover';
import { TimePicker } from './TimePicker';
import type { ParsedQuickAdd, ParsedToken, TokenKind } from './parse';
import s from './QuickAddField.module.css';

export interface QuickAddFieldProps {
  value: string;
  onChange: (next: string) => void;
  parsed: ParsedQuickAdd;
  lists: TaskList[];
  today: CivilDate;
  variant: 'inline' | 'hud';
  placeholder?: string;
  autoFocus?: boolean;
  /** Called on ⏎ with `shiftKey`; each host decides what Shift means. */
  onSubmit: (shiftKey: boolean) => void;
  onCancel: () => void;
  /** Called with the rendered height whenever it changes (HUD resizing). */
  onHeightChange?: (height: number) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

type Editor = 'date' | 'time' | 'list' | null;

interface Segment {
  text: string;
  kind?: TokenKind;
}

/** Split `value` at the token spans so the mirror div can paint them. */
export function segmentize(value: string, tokens: ParsedToken[]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const t of [...tokens].sort((a, b) => a.start - b.start)) {
    if (t.start < pos) continue;
    if (t.start > pos) out.push({ text: value.slice(pos, t.start) });
    out.push({ text: value.slice(t.start, t.end), kind: t.kind });
    pos = t.end;
  }
  if (pos < value.length) out.push({ text: value.slice(pos) });
  return out;
}

const lastOf = (tokens: ParsedToken[], kind: TokenKind): ParsedToken | undefined => [...tokens].reverse().find((t) => t.kind === kind);

const squash = (v: string): string => v.replace(/[ \t]{2,}/g, ' ').replace(/^ +/, '');

/** Replace (or append) the token of a kind with new source text. */
export function replaceToken(value: string, token: ParsedToken | undefined, replacement: string): string {
  if (!token) return replacement ? squash(`${value.replace(/\s+$/, '')} ${replacement} `) : value;
  const next = `${value.slice(0, token.start)}${replacement}${value.slice(token.end)}`;
  return squash(next);
}

/** `#Work` or `#"Side projects"` for a list title. */
export const listTokenText = (title: string): string => (/\s/.test(title) ? `#"${title}"` : `#${title}`);

export function QuickAddField(props: QuickAddFieldProps): ReactElement {
  const { value, onChange, parsed, lists, today, variant, placeholder, autoFocus, onSubmit, onCancel, onHeightChange, inputRef } = props;
  const ownRef = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownRef;
  const mirrorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  // Keep the highlight mirror aligned when the input scrolls horizontally.
  const syncScroll = (): void => {
    if (mirrorRef.current && input.current) mirrorRef.current.scrollLeft = input.current.scrollLeft;
  };

  useLayoutEffect(() => {
    if (!onHeightChange || !rootRef.current) return;
    const el = rootRef.current;
    const report = (): void => onHeightChange(Math.ceil(el.getBoundingClientRect().height));
    report();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [onHeightChange]);

  const dateToken = lastOf(parsed.tokens, 'date');
  const timeToken = lastOf(parsed.tokens, 'time');
  const listToken = lastOf(parsed.tokens, 'list');
  const priorityToken = lastOf(parsed.tokens, 'priority');
  const flagToken = lastOf(parsed.tokens, 'flag');
  const notesToken = lastOf(parsed.tokens, 'notes');

  const removeToken = (token: ParsedToken | undefined): void => {
    if (!token) return;
    onChange(replaceToken(value, token, ''));
    input.current?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    // ⏎ during IME composition commits the composition, never the task.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Plain keys are ours; ⌘/⌃ chords (⌘1…7, ⌘K, ⌘N…) bubble to KeyboardScope so
    // navigation keeps working while typing. KeyboardScope filters what is safe in a text field.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();

    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit(e.shiftKey);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (editor) {
        setEditor(null);
        return;
      }
      if (value !== '') onChange('');
      else onCancel();
      return;
    }
    if (e.key === 'Backspace') {
      if (value === '') {
        // The HUD stays put on an empty backspace; the inline row closes.
        if (variant === 'inline') {
          e.preventDefault();
          onCancel();
        }
        return;
      }
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd || el.selectionStart === null) return;
      const caret = el.selectionStart;
      const trailing = [...parsed.tokens].reverse().find((t) => t.end === caret || (t.end < caret && value.slice(t.end, caret).trim() === ''));
      if (trailing) {
        e.preventDefault();
        onChange(`${value.slice(0, trailing.start).replace(/\s+$/, '')} `.replace(/^ $/, ''));
      }
      return;
    }
  };

  const chipClass = (kind: string): string => `${s.chip} ${s[kind] ?? ''}`.trim();

  return (
    <div className={variant === 'hud' ? `${s.root} ${s.hud}` : s.root} ref={rootRef} data-bt-quickadd={variant}>
      <div className={s.field}>
        <div className={s.mirror} ref={mirrorRef} aria-hidden="true">
          {value === '' ? <span className={s.placeholder}>{placeholder ?? 'Task name…'}</span> : null}
          {segmentize(value, parsed.tokens).map((seg, i) => (
            <span key={i} className={seg.kind ? `${s.tok} ${s[`tok_${seg.kind}`] ?? ''}` : undefined}>
              {seg.text}
            </span>
          ))}
        </div>
        <input
          ref={input}
          className={s.input}
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label="Quick add"
          placeholder=""
          onChange={(e) => {
            onChange(e.target.value);
            setEditor(null);
          }}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
        />
      </div>

      {parsed.tokens.length > 0 || parsed.listQuery ? (
        <div className={s.chips} data-testid="quickadd-chips">
          {dateToken ? (
            <button type="button" className={chipClass('date')} onClick={() => setEditor(editor === 'date' ? null : 'date')} aria-label={`Due ${dateToken.label}`}>
              {dateToken.label}
            </button>
          ) : null}
          {timeToken ? (
            <button type="button" className={chipClass('time')} onClick={() => setEditor(editor === 'time' ? null : 'time')} aria-label={`At ${timeToken.label}`}>
              {timeToken.label}
            </button>
          ) : null}
          {listToken && !parsed.listQuery ? (
            <button type="button" className={chipClass('list')} onClick={() => setEditor(editor === 'list' ? null : 'list')} aria-label={`List ${listToken.label}`}>
              {listToken.label}
            </button>
          ) : null}
          {parsed.listQuery ? (
            <span className={`${s.chip} ${s.warn}`} data-testid="quickadd-unknown-list">
              Create list “{parsed.listQuery}”?
            </span>
          ) : null}
          {priorityToken ? (
            <button type="button" className={chipClass('priority')} onClick={() => removeToken(priorityToken)} aria-label={`Priority ${priorityToken.label} — click to remove`}>
              {priorityToken.label}
            </button>
          ) : null}
          {flagToken ? (
            <button type="button" className={chipClass('flag')} onClick={() => removeToken(flagToken)} aria-label="Flagged — click to remove">
              Flagged
            </button>
          ) : null}
          {notesToken ? <span className={`${s.chip} ${s.notes}`}>Note: {notesToken.label.slice(0, 40)}</span> : null}
        </div>
      ) : null}

      {editor === 'date' ? (
        <div className={s.popoverAnchor}>
          <DatePickerPopover
            value={parsed.due}
            today={today}
            onClose={() => setEditor(null)}
            onPick={(d) => {
              onChange(replaceToken(value, dateToken, d ?? ''));
              setEditor(null);
              input.current?.focus();
            }}
          />
        </div>
      ) : null}

      {editor === 'time' ? (
        <div className={s.popoverAnchor}>
          <TimePicker
            value={parsed.dueTime}
            onClose={() => setEditor(null)}
            onPick={(t) => {
              onChange(replaceToken(value, timeToken, t ? `@${t}` : ''));
              setEditor(null);
              input.current?.focus();
            }}
          />
        </div>
      ) : null}

      {editor === 'list' ? (
        <div className={s.popoverAnchor}>
          <ul className={s.menu} role="menu" aria-label="Move to list">
            {lists.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  role="menuitem"
                  className={s.menuItem}
                  onClick={() => {
                    onChange(replaceToken(value, listToken, listTokenText(l.title)));
                    setEditor(null);
                    input.current?.focus();
                  }}
                >
                  {l.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
