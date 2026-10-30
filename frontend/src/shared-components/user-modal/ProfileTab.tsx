import { RiCheckboxBlankCircleLine, RiEyeOffLine, RiIndeterminateCircleLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { clearRenameStatus, meAtom, RENAME_DAYS, renameAgainAtom, renameBusyAtom, renameMe, renameStatusAtom } from '@/infra/atoms/auth-atoms';
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
  MAX_OFFLINE_NOTE_CHARS,
  myAvatarVersionAtom,
  myNameAtom,
  myOfflineVersionAtom,
  profileAvatarStatusAtom,
  profileBioAtom,
  profileBioStatusAtom,
  profileOfflineNoteAtom,
  profileOfflineNoteStatusAtom,
  profileOfflineStatusAtom,
  removeMyAvatar,
  removeMyOffline,
  saveMyAvatar,
  saveMyBio,
  saveMyOffline,
  saveMyOfflineNote,
  whyNotEditAtom
} from '@/infra/atoms/profile-atoms';
import { closeUserModal, pickTab } from '@/infra/atoms/user-modal-atoms';
import { api, groupWords } from '@/infra/api';
import { cleanName, isDummyName, isValidName } from '@/infra/names';
import { store } from '@/infra/store';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { BUTTON, Field, INPUT, OptionCard, PasswordInput, SECTION_TITLE, Section, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/**
 * A new name for the account (docs/ids.md): the name rule, the password (a stolen cookie must
 * not walk off with the name), a `sure?` because every shared link changes, and a 30 day wait
 * after. On a 200 `me` is already the new name; `identityChanged` tells the rest of the page.
 */
function Rename({ me }: { me: string }) {
  const busy = useAtomValue(renameBusyAtom);
  const status = useAtomValue(renameStatusAtom);
  const again = useAtomValue(renameAgainAtom);
  const [next, setNext] = useState('');
  const [password, setPassword] = useState('');
  const [sure, setSure] = useState(false);

  // Mount only: the last visit's "changed" should not still be there.
  useEffect(() => {
    clearRenameStatus();
  }, []);

  const wanted = cleanName(next);
  const ready = !busy && !again && isValidName(wanted) && !isDummyName(wanted) && wanted !== me && password.length >= 8;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!sure) {
      setSure(true);
      return;
    }
    setSure(false);
    if (await renameMe(wanted, password)) {
      setNext('');
      setPassword('');
      identityChanged('login');
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      {/* for password managers: which account the password belongs to */}
      <input type="text" name="username" value={me} autoComplete="username" readOnly tabIndex={-1} aria-hidden className="sr-only" />
      <fieldset disabled={!!again} className="m-0 flex flex-col gap-4 border-0 p-0 disabled:opacity-60">
        <Field id="profile-new-name" label="new name" hint="a-z 0-9 _ and -. up to 32. lowercase.">
          <input
            id="profile-new-name"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setSure(false);
            }}
            placeholder={me}
            maxLength={32}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby="profile-new-name-hint"
            className={INPUT}
          />
        </Field>
        <Field id="profile-rename-password" label="your password">
          <PasswordInput id="profile-rename-password" value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        {sure ? (
          <Button id="profile-rename" type="submit" variant="danger" flat className={BUTTON} disabled={!ready}>
            {`sure? /watch/${me} becomes /watch/${wanted}`}
          </Button>
        ) : (
          <button id="profile-rename" type="submit" className="text-base font-semibold text-primaryBlue disabled:opacity-40" disabled={!ready}>
            change name
          </button>
        )}
        {sure && (
          <button type="button" onClick={() => setSure(false)} className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline">
            keep {me}
          </button>
        )}
        <Status id="profile-rename-status" text={status || (again ? `you can change it again on ${again.toISOString().slice(0, 10)}` : '')} />
      </div>
    </form>
  );
}

/** The api caps the status here (in characters, the way `chars` counts). `bio` on the wire: the word `status` is the presence choice's (docs/status.md). */
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
 * Who I am, as others see it: the picture, the name, the status. For a login the name is the
 * account's and fixed; for a guest it is the nick, kept in this browser, and changing it is
 * becoming somebody else (the old name keeps its status and picture). Everything saves under the
 * name I am now, through the api's one rule: a free name is anyone's, a claimed one its login's.
 * The links are not here: they are edited on my own page, where they show
 * (SocialsEditor.tsx); this tab points there.
 */
export function ProfileTab() {
  const me = useAtomValue(meAtom);
  const nick = useAtomValue(nickAtom);
  const name = useAtomValue(myNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const avatarStatus = useAtomValue(profileAvatarStatusAtom);
  const bio = useAtomValue(profileBioAtom);
  const bioStatus = useAtomValue(profileBioStatusAtom);
  const canEdit = useAtomValue(canEditProfileAtom);
  const whyNot = useAtomValue(whyNotEditAtom);
  const badges = useAtomValue(myGroupsAtom);
  const presence = useAtomValue(myPresenceAtom);
  const choice = useAtomValue(presenceChoiceAtom);
  const presenceNote = useAtomValue(presenceChoiceNoteAtom);
  const offline = useAtomValue(myOfflineVersionAtom);
  const offlineStatus = useAtomValue(profileOfflineStatusAtom);
  const offlineNote = useAtomValue(profileOfflineNoteAtom);
  const offlineNoteStatus = useAtomValue(profileOfflineNoteStatusAtom);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const offlineFileRef = useRef<HTMLInputElement | null>(null);
  // the nick as it was when its box got focus: leaving the box tells the chat only on a real change
  const nickAtFocus = useRef('');

  // Mount only: the status and picture of the name I am (the same name again keeps the draft),
  // and the groups, for the badges on the card (a login's; a guest has none).
  useEffect(() => {
    void loadMyProfile();
    if (me) void loadGroups();
  }, []);

  const left = MAX_BIO_CHARS - chars(bio.trim());
  const named = isValidName(name) && !isDummyName(name);

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
                badges.map((group) => {
                  const words = groupWords(group);
                  return (
                  <button
                    key={group.name}
                    type="button"
                    onClick={() => pickTab('groups')}
                    className="shrink-0"
                    title={`in the group ${words.title}${words.tag ? ` #${words.tag}` : ''}. groups are in the next tab`}
                  >
                    <Badge group={group} />
                  </button>
                  );
                })}
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
            <button id="profile-avatar-pick" type="button" className="text-base font-semibold text-primaryBlue disabled:opacity-40" disabled={!canEdit} onClick={() => fileRef.current?.click()}>
              {avatar === null ? 'choose picture' : 'change picture'}
            </button>
            {avatar !== null && (
              <button id="profile-avatar-remove" type="button" className="text-base font-semibold text-textTertiary disabled:opacity-40" disabled={!canEdit} onClick={() => void removeMyAvatar()}>
                remove
              </button>
            )}
          </div>
          <Status
            id="profile-avatar-status"
            text={avatarStatus || (canEdit ? 'a square you cut out of any picture, 256px. on your stream and in the preview of its link.' : whyNot)}
          />
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
        description={
          me
            ? `your account name. it is yours alone. it can change once every ${RENAME_DAYS} days, and the old one is kept for you as long.`
            : 'your chat name and your go live default. sign up to make it yours.'
        }
      >
        {me ? (
          <>
            <p className="flex items-center gap-2 font-semibold">
              <span id="profile-me">{me}</span>
              <span className="text-increase" title="logged in: this name is yours">
                ✓
              </span>
            </p>
            <Rename me={me} />
          </>
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

      {/* the status: one line about me, the way a custom status is. under my name on my page, beside it on home,
          in the sidebar and in the preview of my link. `bio` on the wire (the word `status` is the presence choice's) */}
      <Section
        title="status"
        description="one line about you: what you are up to, what the stream is. under your name on your page, beside it on home and in the sidebar, and in the preview of your link."
      >
        <Field id="profile-bio" label="status" hint={`${MAX_BIO_CHARS} characters, one line. empty takes it off.`}>
          <input
            id="profile-bio"
            value={bio}
            onChange={(e) => {
              store.set(profileBioAtom, e.target.value);
              if (store.get(profileBioStatusAtom)) store.set(profileBioStatusAtom, '');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveMyBio();
            }}
            placeholder="what are you up to. what is this stream."
            maxLength={MAX_BIO_CHARS}
            disabled={!canEdit}
            autoComplete="off"
            aria-describedby="profile-bio-hint"
            className={INPUT}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button id="profile-save-bio" type="button" className="text-base font-semibold text-primaryBlue disabled:opacity-40" disabled={!canEdit} onClick={() => void saveMyBio()}>
            save status
          </button>
          <span id="profile-bio-count" className={cn('text-sm tabular-nums text-textTertiary', left < 20 && 'text-decrease')}>
            {left}
          </span>
          <Status id="profile-bio-status" text={bioStatus || (canEdit ? '' : whyNot)} />
        </div>
      </Section>

      {/* the about me (docs/about.md) and the links (docs/socials.md) are edited on my page itself, under the player,
          where they show: this is the way there, since they used to be here */}
      <Section
        title="your page"
        description="the longer piece about you and where else to find you are written on your page itself, under the player, where everyone reads them: the about tab and the socials tab."
      >
        {named ? (
          <p>
            <Link id="profile-your-page" to={`/watch/${name}`} onClick={closeUserModal} className="font-semibold text-primaryBlue underline-offset-2 hover:underline">
              /watch/{name}
            </Link>
          </p>
        ) : (
          <p className="text-sm text-textTertiary">{whyNot}</p>
        )}
      </Section>

      {/* what the stream's page shows while I am not live: a picture where the player would be (the
          way twitch has an offline banner) and a line under the word. the picture is the card of a
          shared link too while I am off (docs/spec.md, "the watch document") */}
      <Section
        title="while you are offline"
        description="your stream's page has no player then: a picture goes where it would be, and a line of yours under the word. the picture is the preview of your link too."
      >
        <div className="flex flex-col gap-3">
          {offline !== null ? (
            <img
              id="profile-offline-preview"
              src={api.offlineUrl(name, offline)}
              alt=""
              draggable={false}
              className="aspect-video w-full max-w-[480px] border border-primaryStroke bg-black object-cover"
            />
          ) : (
            <div className="flex aspect-video w-full max-w-[480px] items-center justify-center border border-dashed border-secondaryStroke p-4 text-center text-sm text-textTertiary">
              no picture yet. the page shows your face and the word, which it does anyway.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={offlineFileRef}
              id="profile-offline-file"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void saveMyOffline(file);
              }}
            />
            <button id="profile-offline-pick" type="button" className="text-base font-semibold text-primaryBlue disabled:opacity-40" disabled={!canEdit} onClick={() => offlineFileRef.current?.click()}>
              {offline === null ? 'choose picture' : 'change picture'}
            </button>
            {offline !== null && (
              <button id="profile-offline-remove" type="button" className="text-base font-semibold text-textTertiary disabled:opacity-40" disabled={!canEdit} onClick={() => void removeMyOffline()}>
                remove
              </button>
            )}
          </div>
          <Status id="profile-offline-status" text={offlineStatus || (canEdit ? 'a wide jpeg, 1280×720: the 16:9 you cut out of your picture.' : whyNot)} />
        </div>
        <Field
          id="profile-offline-note"
          label="the line"
          hint={`${MAX_OFFLINE_NOTE_CHARS} characters, one line. when you are back, where else to find you. empty takes it off.`}
        >
          <input
            id="profile-offline-note"
            value={offlineNote}
            onChange={(e) => {
              store.set(profileOfflineNoteAtom, e.target.value);
              if (store.get(profileOfflineNoteStatusAtom)) store.set(profileOfflineNoteStatusAtom, '');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveMyOfflineNote();
            }}
            placeholder="back tuesday at 8"
            maxLength={MAX_OFFLINE_NOTE_CHARS}
            disabled={!canEdit}
            autoComplete="off"
            aria-describedby="profile-offline-note-hint"
            className={INPUT}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button id="profile-save-offline-note" type="button" className="text-base font-semibold text-primaryBlue disabled:opacity-40" disabled={!canEdit} onClick={() => void saveMyOfflineNote()}>
            save line
          </button>
          <Status id="profile-offline-note-status" text={offlineNoteStatus || (canEdit ? '' : whyNot)} />
        </div>
      </Section>
    </div>
  );
}
