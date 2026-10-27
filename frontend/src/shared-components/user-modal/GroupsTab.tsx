import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useState } from 'react';

import type { Group } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  clearGroupsStatus,
  createGroup,
  deleteGroup,
  groupsAtom,
  groupsBusyAtom,
  groupsLoadedAtom,
  groupsStatusAtom,
  joinGroup,
  leaveGroup,
  loadGroups,
  myGroupsAtom
} from '@/infra/atoms/groups-atoms';
import { pickTab } from '@/infra/atoms/user-modal-atoms';
import { isValidName } from '@/infra/names';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { BUTTON, Field, INPUT, Section, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** The api's caps, as the boxes know them. */
const MAX_BADGE_CHARS = 12;
const MAX_ABOUT_CHARS = 200;
/** The colours to start from: discord's blurple, then the fake streams' box colours. The colour box takes any other. */
const SWATCHES = ['#5865f2', '#f85149', '#3fb950', '#f2cc60', '#bc8cff', '#ff9f43', '#39d2c0', '#ff6bcb'] as const;
/** The buttons in a row of the list: a size down from the pane's, and `flat` like them. */
const SMALL = 'px-3 py-1.5 text-sm';

/**
 * Groups: the badges a name wears in chat. Everyone sees the list; a login joins and leaves,
 * makes groups of its own and deletes those. `bot` is automatic (a bot's socket says so), so
 * it has no join. Every change says hello to the open chat again, so the badges follow at once.
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
        description="join one and its badge goes on your lines. bot is automatic: the fake streams' chatters wear it, nobody joins it, and the chat can hide those lines."
      >
        {loaded === undefined && <p className="text-textTertiary">loading</p>}
        {loaded === false && (
          <Button id="group-reload" flat className={BUTTON} onClick={() => void loadGroups()}>
            try again
          </Button>
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

      {me && <MakeGroup me={me} busy={busy} />}
    </div>
  );
}

function GroupRow({ group, me, busy }: { group: Group; me: string | null; busy: boolean }) {
  const [sure, setSure] = useState(false);
  // the one who made it deletes it. an admin may too, through the api; the page does not know who those are
  const canDelete = me !== null && group.made_by === me;
  return (
    <li id={`group-${group.name}`} data-mine={group.mine || undefined} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <Badge group={group} className="shrink-0" />
      <span className="min-w-0 flex-1 basis-48">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{group.name}</span>
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
        ) : me === null ? null : group.mine ? (
          <Button id={`group-leave-${group.name}`} flat className={SMALL} disabled={busy} onClick={() => void leaveGroup(group.name)}>
            leave
          </Button>
        ) : (
          <Button id={`group-join-${group.name}`} variant="primary" flat className={SMALL} disabled={busy} onClick={() => void joinGroup(group.name)}>
            join
          </Button>
        )}
        {canDelete &&
          (sure ? (
            <>
              <Button id={`group-delete-${group.name}`} variant="danger" flat className={SMALL} disabled={busy} onClick={() => void deleteGroup(group.name, group.mine)}>
                sure? delete
              </Button>
              <button type="button" onClick={() => setSure(false)} className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline">
                keep
              </button>
            </>
          ) : (
            <Button id={`group-delete-${group.name}`} flat className={cn(SMALL, 'text-decrease hover:border-decrease')} disabled={busy} onClick={() => setSure(true)}>
              delete
            </Button>
          ))}
      </span>
    </li>
  );
}

function MakeGroup({ me, busy }: { me: string; busy: boolean }) {
  const [name, setName] = useState('');
  const [badge, setBadge] = useState('');
  const [color, setColor] = useState<string>(SWATCHES[0]);
  const [about, setAbout] = useState('');
  const badgeChars = [...badge.trim()].length;
  const ok = isValidName(name) && badgeChars >= 1 && badgeChars <= MAX_BADGE_CHARS;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;
    if (await createGroup({ name, badge: badge.trim(), color, about: about.trim() })) {
      setName('');
      setBadge('');
      setAbout('');
    }
  }

  return (
    <Section
      title="make a group"
      description="a name, the word on the badge, a colour, a line about it. you are in it from the start. up to 10 of your own; anyone can join."
    >
      {/* no method="dialog": a submit would close the modal. onSubmit owns enter */}
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="group-name" label="name" hint="a-z 0-9 _ -, up to 32.">
            <input
              id="group-name"
              value={name}
              onChange={(e) =>
                setName(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]/g, '')
                    .slice(0, 32)
                )
              }
              placeholder="night-owls"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={32}
              required
              aria-describedby="group-name-hint"
              className={INPUT}
            />
          </Field>
          <Field id="group-badge" label="badge" hint={`1 to ${MAX_BADGE_CHARS} characters. shown in capitals, like BOT.`}>
            <input
              id="group-badge"
              value={badge}
              onChange={(e) => setBadge(e.target.value)}
              placeholder="owl"
              autoComplete="off"
              maxLength={MAX_BADGE_CHARS}
              required
              aria-describedby="group-badge-hint"
              className={INPUT}
            />
          </Field>
        </div>
        <Field id="group-color" label="colour">
          <div className="flex flex-wrap items-center gap-2">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={c === color}
                onClick={() => setColor(c)}
                style={{ backgroundColor: c }}
                className={cn(
                  'h-8 w-8 border-2 transition-[border-color] duration-150',
                  c === color ? 'border-textPrimary' : 'border-transparent hover:border-secondaryStroke'
                )}
              />
            ))}
            <input
              id="group-color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="any other colour"
              title="any other colour"
              className="h-8 w-12 cursor-pointer border border-primaryStroke bg-background p-0.5"
            />
          </div>
        </Field>
        <Field id="group-about" label="about" hint={`optional. up to ${MAX_ABOUT_CHARS} characters.`}>
          <input
            id="group-about"
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="who this is for"
            autoComplete="off"
            maxLength={MAX_ABOUT_CHARS}
            aria-describedby="group-about-hint"
            className={INPUT}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <Button id="group-create" type="submit" variant="primary" flat className={BUTTON} disabled={busy || !ok}>
            make it
          </Button>
          {/* the badge as a chat line will show it, live as you type */}
          <span id="group-preview" className="text-sm text-textSecondary">
            in chat: <span className="font-semibold text-primaryBlue">{me}</span>
            <Badge group={{ name: name || 'new', badge: badge.trim() || 'badge', color }} className="ml-1" />
          </span>
        </div>
      </form>
    </Section>
  );
}
