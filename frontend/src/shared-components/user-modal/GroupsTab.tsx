import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { groupWords, type Group } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  clearGroupsStatus,
  deleteGroup,
  groupsAtom,
  groupsBusyAtom,
  groupsLoadedAtom,
  groupsStatusAtom,
  joinGroup,
  leaveGroup,
  loadGroups,
  setGroupListed,
  myGroupsAtom
} from '@/infra/atoms/groups-atoms';
import { closeUserModal, pickTab } from '@/infra/atoms/user-modal-atoms';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Section, Status } from '@/shared-components/user-modal/parts';

/** The buttons in a row of the list: a size down from the pane's. */
const SMALL = 'px-3 py-1.5 text-sm';

/**
 * Groups: the badges a name wears in chat. Everyone sees the list; a login joins and leaves,
 * and deletes the one it owns. Making one is the groups page's and home's (MakeGroupDialog.tsx),
 * where the banner and the picture go on with it; this tab only points there. `bot` is
 * automatic (a bot's socket says so), so it has no join. Every change says hello to the open
 * chat again, so the badges follow at once.
 */
export function GroupsTab() {
  const me = useAtomValue(meAtom);
  const groups = useAtomValue(groupsAtom);
  const loaded = useAtomValue(groupsLoadedAtom);
  const mine = useAtomValue(myGroupsAtom);
  const busy = useAtomValue(groupsBusyAtom);
  const status = useAtomValue(groupsStatusAtom);

  // Mount only: the list as the server has it, and no status left over from an earlier open.
  useEffect(() => {
    clearGroupsStatus();
    void loadGroups();
  }, []);

  return (
    <div className="divide-y divide-primaryStroke">
      <Section
        title="your badges"
        description={
          me
            ? 'what your name wears in chat: the badge of every group you are in, in the order you joined.'
            : 'a group puts a badge next to your name in chat. groups are for accounts; nobody has to have one.'
        }
      >
        {me ? (
          <p id="my-badges" className="flex flex-wrap items-center gap-1 font-semibold">
            <span className="text-primaryBlue">{me}</span>
            <span className="text-increase" title="logged in: this name is yours">
              ✓
            </span>
            {mine.map((group) => (
              <Badge key={group.name} group={group} className="ml-1" />
            ))}
            {mine.length === 0 && <span className="ml-2 font-normal text-textTertiary">no badges yet. join a group below.</span>}
          </p>
        ) : (
          <p className="text-sm text-textTertiary">
            <button type="button" onClick={() => pickTab('security')} className="text-primaryBlue underline-offset-2 hover:underline">
              sign up or log in
            </button>{' '}
            to join one.
          </p>
        )}
      </Section>

      <Section
        title="groups"
        description={
          <>
            join one and its badge goes on your lines. to make one, with a picture and a banner, go to{' '}
            <Link id="group-make-there" to="/groups" onClick={closeUserModal} className="text-primaryBlue underline-offset-2 hover:underline">
              the groups page
            </Link>
            : one each. bot is automatic: the fake streams&apos; chatters wear it, nobody joins it, and the chat can hide those lines.
          </>
        }
      >
        {/* before the list has answered: the list's box with a few rows' worth of grey in it, the badge and the words */}
        {loaded === undefined && (
          <Skeleton id="group-list-loading" className="divide-y divide-primaryStroke border border-primaryStroke bg-background">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Bone className="h-5 w-14 shrink-0" />
                <Bone className="h-4 w-40 max-w-full" />
              </div>
            ))}
          </Skeleton>
        )}
        {loaded === false && (
          <button id="group-reload" type="button" className="self-start text-base font-semibold text-primaryBlue" onClick={() => void loadGroups()}>
            try again
          </button>
        )}
        {groups.length > 0 && (
          <ul id="group-list" className="divide-y divide-primaryStroke border border-primaryStroke bg-background">
            {groups.map((group) => (
              <GroupRow key={group.name} group={group} me={me ?? null} busy={busy} />
            ))}
          </ul>
        )}
        <Status id="group-status" text={status} />
      </Section>
    </div>
  );
}

function GroupRow({ group, me, busy }: { group: Group; me: string | null; busy: boolean }) {
  const [sure, setSure] = useState(false);
  const [leaveSure, setLeaveSure] = useState(false);
  // the one who made it deletes it. an admin may too, through the api; the page does not know who those are
  const canDelete = me !== null && group.made_by === me;
  const words = groupWords(group);
  return (
    <li id={`group-${group.name}`} data-title={words.title} data-mine={group.mine || undefined} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <Badge group={group} className="shrink-0" />
      <span className="min-w-0 flex-1 basis-48">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{words.title}</span>
          {words.tag && <span className="text-sm text-textTertiary">#{words.tag}</span>}
          <span className="text-sm tabular-nums text-textTertiary">
            {group.members} {group.members === 1 ? 'member' : 'members'}
          </span>
          {group.made_by && <span className="text-sm text-textTertiary">by {group.made_by}</span>}
        </span>
        {group.about && <span className="block text-sm text-textSecondary">{group.about}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {group.automatic ? (
          <span className="text-sm text-textTertiary">automatic</span>
        ) : me === null ? null : group.mine && leaveSure ? (
          <>
            <Button id={`group-leave-${group.name}`} variant="danger" className={SMALL} disabled={busy} onClick={() => void leaveGroup(group.name)}>
              {group.members <= 1 ? 'sure? deletes it' : 'sure?'}
            </Button>
            <button type="button" onClick={() => setLeaveSure(false)} className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline">
              keep
            </button>
          </>
        ) : group.mine ? (
          <button
            id={`group-leave-${group.name}`}
            type="button"
            className="text-sm font-semibold text-textTertiary disabled:opacity-40"
            disabled={busy}
            onClick={() => setLeaveSure(true)}
          >
            leave
          </button>
        ) : (
          <Button id={`group-join-${group.name}`} variant="primary" className={SMALL} disabled={busy} onClick={() => void joinGroup(group.name)}>
            join
          </Button>
        )}
        {canDelete && group.public !== undefined && (
          <button
            id={`group-access-${group.name}`}
            type="button"
            className="text-sm font-semibold text-primaryBlue disabled:opacity-40"
            disabled={busy}
            onClick={() => void setGroupListed(group.name, group.public === false, words.title)}
          >
            {group.public === false ? 'make public' : 'make private'}
          </button>
        )}
        {canDelete && (
          <button
            id={`group-delete-${group.name}`}
            type="button"
            className="text-sm font-semibold text-decrease disabled:opacity-40"
            disabled={busy}
            onClick={() => setSure(true)}
          >
            delete
          </button>
        )}
        {sure && (
          <ConfirmDialog
            id={`group-delete-${group.name}-confirm`}
            title={`delete ${words.title}?`}
            message="the group goes, and everyone in it is out."
            yes="yes, delete"
            onYes={() => {
              setSure(false);
              void deleteGroup(group.name, group.mine);
            }}
            onNo={() => setSure(false)}
          />
        )}
      </span>
    </li>
  );
}
