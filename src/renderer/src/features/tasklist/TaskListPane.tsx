import { type ReactElement } from 'react';
import { useStore } from '../../store/store';
import { selectDefaultListId } from '../../store/selectors/views';
import { useDelayedFlag } from '../../hooks/useDelayedFlag';
import { Skeleton } from '../../components/Skeleton';
import { InlineQuickAdd } from '../quickadd/InlineQuickAdd';
import { GithubViewHeader } from '../github';
import { TaskList } from './TaskList';
import { BulkBar } from './BulkBar';
import s from './TaskList.module.css';

function SkeletonRows(): ReactElement {
  return (
    <div aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className={s.skeletonRow}>
          <Skeleton width={16} height={16} radius="var(--bt-radius-full)" />
          <Skeleton width={`${52 - i * 4}%`} height={9} />
        </div>
      ))}
    </div>
  );
}

export function TaskListPane(): ReactElement {
  const hydrated = useStore((st) => st.hydrated);
  const inlineAddFor = useStore((st) => st.inlineAddFor);
  const setInlineAddFor = useStore((st) => st.setInlineAddFor);
  const defaultListId = useStore(selectDefaultListId);

  // Skeletons only after 150ms, so a warm start never flashes them.
  const showSkeleton = useDelayedFlag(!hydrated, 150);

  return (
    <div className={s.pane}>
      <GithubViewHeader />
      {inlineAddFor ? (
        <div className={s.quickAddSlot}>
          <InlineQuickAdd
            listId={inlineAddFor.listId ?? defaultListId}
            parentId={inlineAddFor.parentId}
            autoFocus
            onDone={() => setInlineAddFor(null)}
          />
        </div>
      ) : null}

      {hydrated ? <TaskList /> : <div className={s.scroller}>{showSkeleton ? <SkeletonRows /> : null}</div>}

      <BulkBar />
    </div>
  );
}
