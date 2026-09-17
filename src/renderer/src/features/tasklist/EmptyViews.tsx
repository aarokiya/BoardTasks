import type { ReactElement } from 'react';
import type { ViewId } from '@shared/constants';
import { useStore } from '../../store/store';
import { runCommand } from '../../commands/registry';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import {
  IconCalendar, IconCheckCircle, IconGithub, IconInbox, IconPlus, IconSearch, IconSun,
} from '../../components/icons';

export interface ViewEmptyStateProps {
  view: ViewId;
  filtered: boolean;
}

export function ViewEmptyState({ view, filtered }: ViewEmptyStateProps): ReactElement {
  const setView = useStore((st) => st.setView);
  const setFilter = useStore((st) => st.setFilter);
  const filterQuery = useStore((st) => st.filterQuery);
  const openOverlay = useStore((st) => st.openOverlay);

  if (filtered) {
    return (
      <EmptyState
        icon={<IconSearch size={20} />}
        title="No matches"
        body={<>Nothing here matches &ldquo;{filterQuery}&rdquo;.</>}
        actions={<Button onClick={() => setFilter('')}>Clear filter</Button>}
      />
    );
  }

  if (view.startsWith('list:')) {
    return (
      <EmptyState
        icon={<IconInbox size={20} />}
        title="No tasks yet"
        body="Press ⌘N to add the first one."
        actions={<Button variant="primary" icon={<IconPlus size={13} />} onClick={() => void runCommand('create.task')}>New task</Button>}
      />
    );
  }

  switch (view) {
    case 'today':
      return (
        <EmptyState
          icon={<IconSun size={20} />}
          title="Nothing due today"
          body="Enjoy it — or get a head start on what's coming."
          actions={<Button onClick={() => setView('upcoming')}>Go to Upcoming</Button>}
        />
      );
    case 'upcoming':
      return (
        <EmptyState
          icon={<IconCalendar size={20} />}
          title="Nothing scheduled"
          body="Tasks due in the next seven days show up here."
          actions={<Button variant="primary" icon={<IconPlus size={13} />} onClick={() => void runCommand('create.task')}>New task</Button>}
        />
      );
    case 'overdue':
      return <EmptyState icon={<IconCheckCircle size={20} />} title="Nothing overdue" body="You're completely caught up." />;
    case 'all':
      return (
        <EmptyState
          icon={<IconInbox size={20} />}
          title="No tasks yet"
          body="Everything you add to any list shows up here."
          actions={<Button variant="primary" icon={<IconPlus size={13} />} onClick={() => void runCommand('create.task')}>New task</Button>}
        />
      );
    case 'nodate':
      return <EmptyState icon={<IconCalendar size={20} />} title="Everything has a date" body="Tasks without a due date collect here." />;
    case 'github':
      return (
        <EmptyState
          icon={<IconGithub size={20} />}
          title="Nothing linked to GitHub"
          body="Link a task to a GitHub issue or pull request and it shows up here with its status."
          actions={
            <>
              <Button variant="primary" onClick={() => openOverlay('settings')}>Connect GitHub</Button>
              <Button onClick={() => void runCommand('github.link')}>Link an issue…</Button>
            </>
          }
        />
      );
    case 'completed':
      return <EmptyState icon={<IconCheckCircle size={20} />} title="Nothing completed yet" body="Completed tasks will appear here." />;
    default:
      return <EmptyState icon={<IconInbox size={20} />} title="Nothing here" />;
  }
}
