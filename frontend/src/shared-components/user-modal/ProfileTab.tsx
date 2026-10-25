import { RiCheckboxBlankCircleLine, RiEyeOffLine, RiIndeterminateCircleLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useRef } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { MAX_CHAT_CHARS, chars, nickAtom, setNick } from '@/infra/atoms/chat-atoms';
import {
  myPresenceAtom,
  PRESENCE_TEXT,
  PRESENCE_WORD,
  type PresenceChoice,
  presenceChoiceAtom,
  presenceChoiceNoteAtom,
  setPresenceChoice
} from '@/infra/atoms/presence-atoms';
import { loadGroups, myGroupsAtom } from '@/infra/atoms/groups-atoms';
import {
  canEditProfileAtom,
  identityChanged,
  loadMyProfile,
  myAvatarVersionAtom,
  myNameAtom,
  profileAvatarStatusAtom,
  profileBioAtom,
  profileBioStatusAtom,
  profileVerifiedAtom,
  removeMyAvatar,
  saveMyAvatar,
  saveMyBio
} from '@/infra/atoms/profile-atoms';
import { pickTab } from '@/infra/atoms/user-modal-atoms';
import { isDummyName, isValidName } from '@/infra/names';
import { store } from '@/infra/store';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { BUTTON, Field, INPUT, OptionCard, SECTION_TITLE, Section, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** The api caps the bio here (in characters, the way `chars` counts). */
const MAX_BIO_CHARS = MAX_CHAT_CHARS;

/** The three choices as cards. `invisible` shows as `offline` to everyone else; the word on the card says so. */
const PRESENCE_OPTIONS: readonly { choice: PresenceChoice; label: string; detail: string; icon: ReactNode }[] = [
  {
    choice: 'online',
    label: 'online',
    detail: 'the green square while a tab is open',
    icon: <RiCheckboxBlankCircleLine aria-hidden size={28} className="text-increase" />
  },
  {
    choice: 'dnd',
    label: 'do not disturb',
    detail: 'here, but say so. the red square',
    icon: <RiIndeterminateCircleLine aria-hidden size={28} className="text-decrease" />
  },
  {
    choice: 'invisible',
    label: 'appear offline',
    detail: 'grey to everyone else. you still see everything',
    icon: <RiEyeOffLine aria-hidden size={28} className="text-textTertiary" />
  }
];

/**
 * Who I am, as others see it: the picture, the name, the bio. For a login the name is the
 * account's and fixed; for a guest it is the nick, kept in this browser, and changing it is
 * becoming somebody else (the old name keeps its bio and picture). Everything saves under the
 * name I am now, through the api's one rule: a free name is anyone's, a claimed one its login's.
 */
export function ProfileTab() {
  const me = useAtomValue(meAtom);
  const nick = useAtomValue(nickAtom);
  const name = useAtomValue(myNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const avatarStatus = useAtomValue(profileAvatarStatusAtom);
  const bio = useAtomValue(profileBioAtom);
  const bioStatus = useAtomValue(profileBioStatusAtom);
  const verified = useAtomValue(profileVerifiedAtom);
  const canEdit = useAtomValue(canEditProfileAtom);
  const badges = useAtomValue(myGroupsAtom);
  const presence = useAtomValue(myPresenceAtom);
  const choice = useAtomValue(presenceChoiceAtom);
  const presenceNote = useAtomValue(presenceChoiceNoteAtom);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // the nick as it was when its box got focus: leaving the box tells the chat only on a real change
  const nickAtFocus = useRef('');

  // Mount only: the bio and picture of the name I am (the same name again keeps the draft),
  // and the groups, for the badges on the card (a login's; a guest has none).
  useEffect(() => {
    void loadMyProfile();
    if (me) void loadGroups();
  }, []);

  const left = MAX_BIO_CHARS - chars(bio.trim());
  const named = isValidName(name);
  const whyNot = !named
    ? 'pick a name first.'
    : isDummyName(name)
      ? 'a reserved name: it belongs to the fake streams, nobody writes it.'
      : verified && me !== name
        ? 'that name has an account. log in as it to change these.'
        : '';

  function commitNick() {
    const was = nickAtFocus.current;
    if (store.get(nickAtom) !== was) identityChanged('nick', was);
  }

  return (
    <div className="divide-y divide-primaryStroke">
      {/* the card: the face, the name, how I am here, and the picture's buttons */}
      <div className="flex flex-wrap items-start gap-5 border border-primaryStroke bg-background p-5">
        <Face name={name} version={avatar} className="h-24 w-24 text-4xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xl font-semibold leading-tight">
              <span className={cn('truncate', !name && 'font-normal text-textTertiary')}>{me ?? (nick || 'pick a name')}</span>
              {me ? (
                <span className="shrink-0 text-increase" title="logged in: this name is yours">
                  ✓
                </span>
              ) : (
                <span className="shrink-0 border border-primaryStroke px-1.5 text-xs font-semibold uppercase leading-5 tracking-wider text-textTertiary">guest</span>
              )}
              {/* the badges my chat lines wear: my groups, in the order joined. the groups tab changes them */}
              {me &&
                badges.map((group) => (
                  <button
                    key={group.name}
                    type="button"
                    onClick={() => pickTab('groups')}
                    className="shrink-0"
                    title={`in the group ${group.name}. groups are in the next tab`}
                  >
                    <Badge group={group} />
                  </button>
                ))}
            </p>
            <p className="mt-1 text-sm text-textSecondary">
              {me ? 'your account. only you can go live, edit this or talk as it.' : 'a free name, kept in this browser. sign up to make it yours.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              id="profile-avatar-file"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void saveMyAvatar(file);
              }}
            />
            <Button id="profile-avatar-pick" className={BUTTON} disabled={!canEdit} onClick={() => fileRef.current?.click()}>
              {avatar === null ? 'choose picture' : 'change picture'}
            </Button>
            {avatar !== null && (
              <Button id="profile-avatar-remove" className={BUTTON} disabled={!canEdit} onClick={() => void removeMyAvatar()}>
                remove
              </Button>
            )}
          </div>
          <Status id="profile-avatar-status" text={avatarStatus || (canEdit ? 'a square jpeg, 256px. on your stream and in the preview of its link.' : whyNot)} />
        </div>
      </div>

      {/* the presence choice (docs/status.md): three cards like the layout and theme pickers. the
          chosen one is what the server has; the square in the corner follows the `me` frame */}
      <fieldset disabled={!canEdit} className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0 disabled:opacity-60">
        <legend className={SECTION_TITLE}>presence</legend>
        <p className="mt-1 text-textSecondary">
          the word next to your name while a tab of this site is open. right now:{' '}
          <span className={cn('font-semibold', PRESENCE_TEXT[presence])}>{PRESENCE_WORD[presence]}</span>
        </p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PRESENCE_OPTIONS.map(({ choice: c, label, detail, icon }) => (
            <OptionCard
              key={c}
              id={`presence-${c}`}
              name="presence"
              checked={c === choice}
              onChange={() => void setPresenceChoice(name, c)}
              picture={icon}
              label={label}
              detail={detail}
            />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">streaming while you are live, whatever you pick. kept with the name, so your phone agrees.</p>
        <Status id="presence-note" text={presenceNote || (canEdit ? '' : whyNot)} />
      </fieldset>

      <Section
        title="username"
        description={me ? 'your account name. it is yours alone, and it does not change.' : 'your chat name and your go live default. sign up to make it yours.'}
      >
        {me ? (
          <p className="flex items-center gap-2 font-semibold">
            <span id="profile-me">{me}</span>
            <span className="text-increase" title="logged in: this name is yours">
              ✓
            </span>
          </p>
        ) : (
          <Field id="profile-name" label="name" hint={`letters, digits, _ and -. up to 24.${nick && name !== nick ? ` saved as ${name}.` : ''}`}>
            <input
              id="profile-name"
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              onFocus={(e) => {
                nickAtFocus.current = e.currentTarget.value;
              }}
              onBlur={commitNick}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              placeholder="pick a name"
              maxLength={24}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby="profile-name-hint"
              className={INPUT}
            />
          </Field>
        )}
        {!me && (
          <p className="text-sm text-textTertiary">
            an account keeps the name yours.{' '}
            <button type="button" onClick={() => pickTab('security')} className="text-primaryBlue underline-offset-2 hover:underline">
              sign up or log in
            </button>
          </p>
        )}
      </Section>

      <Section title="bio" description="who you are. what the stream is. on your stream's page and on home while you are live.">
        <Field id="profile-bio" label="bio">
          <textarea
            id="profile-bio"
            value={bio}
            onChange={(e) => {
              store.set(profileBioAtom, e.target.value);
              if (store.get(profileBioStatusAtom)) store.set(profileBioStatusAtom, '');
            }}
            placeholder="who are you. what is this stream."
            maxLength={MAX_BIO_CHARS}
            disabled={!canEdit}
            className={cn(INPUT, 'min-h-[120px] resize-y')}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button id="profile-save-bio" variant="primary" className={BUTTON} disabled={!canEdit} onClick={() => void saveMyBio()}>
            save bio
          </Button>
          <span id="profile-bio-count" className={cn('text-sm tabular-nums text-textTertiary', left < 20 && 'text-decrease')}>
            {left}
          </span>
          <Status id="profile-bio-status" text={bioStatus || (canEdit ? '' : whyNot)} />
        </div>
      </Section>
    </div>
  );
}
