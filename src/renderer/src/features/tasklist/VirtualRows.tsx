/* eslint-disable react-hooks/incompatible-library --
   @tanstack/react-virtual's imperative measurement is opaque to the React
   compiler. It is only mounted above 200 rows, in a leaf component. */
import { type ReactElement, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Row } from '../../store/selectors/views';
import s from './TaskList.module.css';

export interface VirtualRowsProps {
  rows: Row[];
  scrollRef: RefObject<HTMLDivElement | null>;
  rowHeight: number;
  renderRow: (row: Row, index: number) => ReactNode;
}

/** Only mounted above 200 rows — below that the DOM cost is lower than the bookkeeping. */
export function VirtualRows({ rows, scrollRef, rowHeight, renderRow }: VirtualRowsProps): ReactElement {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'group' ? 32 : rowHeight),
    overscan: 12,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  return (
    <div className={s.virtualInner} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((v) => {
        const row = rows[v.index];
        if (!row) return null;
        return (
          <div
            key={row.id}
            className={s.virtualRow}
            data-index={v.index}
            ref={virtualizer.measureElement}
            style={{ transform: `translateY(${v.start}px)` }}
          >
            {renderRow(row, v.index)}
          </div>
        );
      })}
    </div>
  );
}
