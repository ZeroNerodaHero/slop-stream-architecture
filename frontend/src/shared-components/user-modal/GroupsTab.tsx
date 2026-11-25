import { RiCloseLine, RiGroupLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { groupWords, type Group, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  clearGroupsStatus,
  groupsAtom,
  groupsBusyAtom,
  groupsLoadedAtom,
  groupsStatusAtom,
  leaveGroup,
  loadGroups,
  loadMyServers,
  myServersAtom,
  setPrimaryGroup
} from '@/infra/atoms/groups-atoms';
import { closeUserModal, pickTab } from '@/infra/atoms/user-modal-atoms';
import { useIsMobile } from '@/infra/mobile';
import { Button, buttonClassName } from '@/shared-components/Button';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { GROUP_SQUARE_BOX, GroupSquareFace } from '@/shared-components/GroupSquare';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Tooltip } from '@/shared-components/Tooltip';
import { Block, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const GRID = 'grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3';

export function GroupsTab() {
  const me = useAtomValue(meAtom);
  const groups = useAtomValue(groupsAtom);
  const loaded = useAtomValue(groupsLoadedAtom);
  const servers = useAtomValue(myServersAtom);
  const busy = useAtomValue(groupsBusyAtom);
  const status = useAtomValue(groupsStatusAtom);
  const mobile = useIsMobile();

  useEffect(() => {
    clearGroupsStatus();
    void loadGroups();
    void loadMyServers();
  }, []);

  if (!me)
    return (
      <div className="divide-y divide-primaryStroke">
        <Block title="groups">
          <Button id="groups-log-in" size="sm" variant="outline" onClick={() => pickTab('security')}>
            log in to join
          </Button>
        </Block>
      </div>
    );

  const mine = groups.filter((g) => g.mine && !g.automatic);

  return (
    <div className="divide-y divide-primaryStroke">
      <Block title="groups" tip={mobile ? 'tap one to wear its badge. leave from the group page' : 'click one to wear its badge in chat'}>
        {loaded === undefined && (
          <Skeleton id="group-list-loading" className={GRID}>
            {Array.from({ length: 4 }, (_, i) => (
              <Bone key={i} className="aspect-square rounded-card" />
            ))}
          </Skeleton>
        )}
        {loaded === false && (
          <Button id="group-reload" size="sm" onClick={() => void loadGroups()}>
            try again
          </Button>
        )}
        {loaded && mine.length === 0 && (
          <div id="groups-empty" className="flex flex-col items-center gap-2 rounded-card border border-dashed border-secondaryStroke px-4 py-8 text-sm text-textTertiary">
            <RiGroupLine aria-hidden size={28} />
            no groups yet
            <Link id="groups-find" to="/groups" onClick={closeUserModal} className={buttonClassName('outline', undefined, 'sm')}>
              find groups
            </Link>
          </div>
        )}
        {mine.length > 0 && (
          <ul id="group-list" role="radiogroup" aria-label="primary group" className={GRID}>
            {mine.map((group) => (
              <GroupPick key={group.name} group={group} server={servers?.find((s) => s.name === group.name)} busy={busy} mobile={mobile} />
            ))}
          </ul>
        )}
        <Status id="group-status" text={status} quiet />
      </Block>
    </div>
  );
}

function GroupPick({ group, server, busy, mobile }: { group: Group; server: Server | undefined; busy: boolean; mobile: boolean }) {
  const [leaving, setLeaving] = useState(false);
  const words = groupWords(group);
  const primary = group.primary === true;
  const pickable = group.primary !== undefined;
  const shown: Server = {
    ...group,
    icon: server?.icon ?? null,
    banner: server?.banner ?? null,
    live: server?.live,
    channels: []
  };
  return (
    <li id={`group-${group.name}`} data-title={words.title} data-primary={primary || undefined} className="group/sq relative">
      <button
        id={`group-primary-${group.name}`}
        type="button"
        role="radio"
        aria-checked={primary}
        aria-label={words.tag ? `${words.title} #${words.tag}` : words.title}
        disabled={busy || !pickable}
        onClick={() => void setPrimaryGroup(group.name, !primary)}
        className={cn(
          GROUP_SQUARE_BOX,
          'group relative flex w-full flex-col justify-end overflow-hidden text-left transition-[border-color] duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default',
          primary && 'border-2 border-primaryBlue'
        )}
      >
        <GroupSquareFace
          server={shown}
          compact
          corner={
            primary && (
              <span className="absolute right-2 top-2 rounded-control bg-primaryBlue px-1.5 py-0.5 text-xs font-semibold text-white md:group-hover/sq:opacity-0 md:group-focus-within/sq:opacity-0">
                primary
              </span>
            )
          }
        />
      </button>
      {!mobile && (
        <Tooltip content="leave group">
          <Button
            id={`group-leave-${group.name}`}
            size="sm"
            aria-label={`leave ${words.title}`}
            disabled={busy}
            onClick={() => setLeaving(true)}
            className="absolute right-2 top-2 h-7 w-7 bg-background/90 p-0 opacity-0 focus-visible:opacity-100 group-hover/sq:opacity-100 group-focus-within/sq:opacity-100"
          >
            <RiCloseLine aria-hidden size={16} />
          </Button>
        </Tooltip>
      )}
      {leaving && (
        <ConfirmDialog
          id={`group-leave-${group.name}-confirm`}
          title={`leave ${words.title}?`}
          message={group.members <= 1 ? 'you are the last one in it: it goes with you.' : 'its badge comes off your name. you can join again from its page.'}
          yes={group.members <= 1 ? 'yes, leave and delete' : 'yes, leave'}
          onYes={() => {
            setLeaving(false);
            void leaveGroup(group.name);
          }}
          onNo={() => setLeaving(false)}
        />
      )}
    </li>
  );
}
