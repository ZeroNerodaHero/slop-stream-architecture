import { RiCameraLine, RiCheckboxBlankCircleLine, RiEyeOffLine, RiIndeterminateCircleLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  clearRenameStatus,
  hasPasswordAtom,
  heldNamesAtom,
  loadOAuthProviders,
  meAtom,
  oauthProvidersAtom,
  oauthVerifiedAtom,
  RENAME_DAYS,
  renameAgainAtom,
  renameBusyAtom,
  renameMe,
  renameStatusAtom
} from '@/infra/atoms/auth-atoms';
import { chars, nickAtom, setNick } from '@/infra/atoms/chat-atoms';
import { type PresenceChoice, presenceChoiceAtom, presenceChoiceNoteAtom, setPresenceChoice } from '@/infra/atoms/presence-atoms';
import { loadGroups, myBadgesAtom } from '@/infra/atoms/groups-atoms';
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
import { OAuthMark } from '@/shared-components/OAuthMark';
import { PicturePick } from '@/shared-components/PicturePick';
import { INPUT } from '@/shared-components/input';
import { WELCOME_TIP, WelcomeEditor } from '@/shared-components/WelcomeEditor';
import { Block, OptionCard, PasswordInput, Status } from '@/shared-components/user-modal/parts';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/**
 * A new name for the account (docs/ids.md): the name rule, the password (a stolen cookie must
 * not walk off with the name), a `sure?` because every shared link changes, and a 30 day wait
 * after. On a 200 `me` is already the new name; `identityChanged` tells the rest of the page.
 */
function Rename({ me }: { me: string }) {
  const busy = useAtomValue(renameBusyAtom);
  const status = useAtomValue(renameStatusAtom);
  const wait = useAtomValue(renameAgainAtom);
  const held = useAtomValue(heldNamesAtom);
  const hasPassword = useAtomValue(hasPasswordAtom);
  const [next, setNext] = useState('');
  const [password, setPassword] = useState('');
  const [sure, setSure] = useState(false);

  // Mount only: the last visit's "changed" should not still be there.
  useEffect(() => {
    clearRenameStatus();
  }, []);

  const wanted = cleanName(next);
  // going back onto one of my own held names never waits (docs/ids.md)
  const again = held.includes(wanted) ? null : wait;
  const ready = !busy && !again && isValidName(wanted) && !isDummyName(wanted) && wanted !== me && (!hasPassword || password.length >= 8);

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

  const hint = ['a-z 0-9 _ -', '32 max', again && `next ${again.toISOString().slice(0, 10)}`, held.length > 0 && `held: ${held.join(', ')}`].filter(Boolean).join(' · ');

  return (
    <form onSubmit={(e) => void submit(e)}>
      {/* for password managers: which account the password belongs to */}
      <input type="text" name="username" value={me} autoComplete="username" readOnly tabIndex={-1} aria-hidden className="sr-only" />
      <div className="flex flex-wrap gap-1.5">
        <input
          id="profile-new-name"
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
            setSure(false);
          }}
          aria-label="new name"
          placeholder="name"
          maxLength={32}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby="profile-new-name-hint"
          className={cn(INPUT, 'min-w-0 flex-1 basis-40')}
        />
        {hasPassword && (
          <PasswordInput
            id="profile-rename-password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            placeholder="password"
            label="your password"
            className="min-w-0 flex-1 basis-40"
          />
        )}
        {sure ? (
          <>
            <Button id="profile-rename" type="submit" size="sm" variant="danger" disabled={!ready}>
              {`sure? /watch/${me} becomes /watch/${wanted}`}
            </Button>
            <Button size="sm" onClick={() => setSure(false)}>
              keep {me}
            </Button>
          </>
        ) : (
          <Button id="profile-rename" type="submit" size="sm" variant="outline" disabled={!ready}>
            rename
          </Button>
        )}
      </div>
      <p id="profile-new-name-hint" className="mt-1 text-xs text-textTertiary">
        {hint}
      </p>
      <Status id="profile-rename-status" text={status} quiet />
    </form>
  );
}

/** The api caps the status here (in characters, the way `chars` counts; main.rs `MAX_BIO_CHARS`). `bio` on the wire: the word `status` is the presence choice's (docs/status.md). */
const MAX_BIO_CHARS = 200;

/** The three choices as cards. `invisible` shows as `offline` to everyone else. */
const PRESENCE_OPTIONS: readonly { choice: PresenceChoice; label: string; icon: ReactNode }[] = [
  {
    choice: 'online',
    label: 'online',
    icon: <RiCheckboxBlankCircleLine aria-hidden size={28} className="text-increase" />
  },
  {
    choice: 'dnd',
    label: 'do not disturb',
    icon: <RiIndeterminateCircleLine aria-hidden size={28} className="text-decrease" />
  },
  {
    choice: 'invisible',
    label: 'appear offline',
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
  const oauthVerified = useAtomValue(oauthVerifiedAtom);
  const oauthProviders = useAtomValue(oauthProvidersAtom);
  // which providers are on here: the line that says how to get verified names them
  useEffect(() => {
    if (me) void loadOAuthProviders();
  }, [me]);
  const nick = useAtomValue(nickAtom);
  const name = useAtomValue(myNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const avatarStatus = useAtomValue(profileAvatarStatusAtom);
  const bio = useAtomValue(profileBioAtom);
  const bioStatus = useAtomValue(profileBioStatusAtom);
  const canEdit = useAtomValue(canEditProfileAtom);
  const whyNot = useAtomValue(whyNotEditAtom);
  const badges = useAtomValue(myBadgesAtom);
  const choice = useAtomValue(presenceChoiceAtom);
  const presenceNote = useAtomValue(presenceChoiceNoteAtom);
  const offline = useAtomValue(myOfflineVersionAtom);
  const offlineStatus = useAtomValue(profileOfflineStatusAtom);
  const offlineNote = useAtomValue(profileOfflineNoteAtom);
  const offlineNoteStatus = useAtomValue(profileOfflineNoteStatusAtom);
  // the nick as it was when its box got focus: leaving the box tells the chat only on a real change
  const nickAtFocus = useRef('');

  // Mount only: the status and picture of the name I am (the same name again keeps the draft),
  // and the groups, for the badges on the card (a login's; a guest has none).
  useEffect(() => {
    void loadMyProfile();
    if (me) void loadGroups();
  }, []);

  const left = MAX_BIO_CHARS - chars(bio.trim());
  const noteLeft = MAX_OFFLINE_NOTE_CHARS - chars(offlineNote.trim());
  const named = isValidName(name) && !isDummyName(name);

  function commitNick() {
    if (store.get(nickAtom) !== nickAtFocus.current) identityChanged('nick');
  }

  return (
    <div className="divide-y divide-primaryStroke">
      {/* the card: the face, the name, the way to my page. the face itself is the way to a new picture, as a
          group's picture is: a camera sits on its corner, and the crop dialog takes it from there */}
      <section className="flex flex-wrap items-center gap-3 pb-4">
        <div className="group/avatar relative flex shrink-0">
          <Face name={name} version={avatar} className="h-14 w-14 text-2xl" />
          {canEdit && (
            <>
              <span
                aria-hidden
                className="absolute bottom-0 right-0 flex h-5 w-5 items-center justify-center bg-black/70 text-white group-hover/avatar:opacity-0 [@media(hover:none)]:hidden"
              >
                <RiCameraLine size={12} />
              </span>
              <PicturePick
                id="profile-avatar-file"
                label="change picture"
                icon={12}
                reveal="group-hover/avatar:opacity-100"
                className="inset-0"
                onPick={(file) => void saveMyAvatar(file)}
              />
            </>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 font-semibold leading-tight">
            <span className={cn('truncate', !name && 'font-normal text-textTertiary')}>{me ?? (nick || 'pick a name')}</span>
            {me ? (
              <Tooltip content="logged in: this name is yours">
                <span role="img" aria-label="logged in" className="shrink-0 text-increase">
                  ✓
                </span>
              </Tooltip>
            ) : (
              <span className="shrink-0 border border-primaryStroke px-1.5 text-xs font-semibold uppercase leading-5 tracking-wider text-textTertiary">guest</span>
            )}
            {me && oauthVerified && <OAuthMark id="profile-oauth-verified" size={14} />}
            {/* the badges my chat lines wear: one only: my primary group's, else my first group's. the groups tab changes them */}
            {me &&
              badges.map((group) => {
                const words = groupWords(group);
                return (
                  <Tooltip key={group.name} content={`${words.title}${words.tag ? ` #${words.tag}` : ''}: change it in groups`}>
                    <button type="button" onClick={() => pickTab('groups')} className="shrink-0">
                      <Badge group={group} />
                    </button>
                  </Tooltip>
                );
              })}
          </p>
          {named && (
            <Link id="profile-your-page" to={`/watch/${name}`} onClick={closeUserModal} className="text-sm text-primaryBlue underline-offset-2 hover:underline">
              /watch/{name}
            </Link>
          )}
          <Status id="profile-avatar-status" text={avatarStatus || (canEdit ? '' : whyNot)} quiet />
        </div>
        {(avatar !== null || (me && !oauthVerified && !!oauthProviders?.length)) && (
          <div className="flex flex-wrap gap-1.5">
            {me && !oauthVerified && !!oauthProviders?.length && (
              <Button id="profile-get-verified" size="sm" variant="outline" onClick={() => pickTab('security')}>
                get verified
              </Button>
            )}
            {avatar !== null && (
              <Button id="profile-avatar-remove" size="sm" variant="outline-danger" disabled={!canEdit} onClick={() => void removeMyAvatar()}>
                remove
              </Button>
            )}
          </div>
        )}
      </section>

      {/* the presence choice (docs/status.md): three cards in a row. the chosen one is what the server has;
          the square in the corner follows the `me` frame */}
      <Block title="presence" tip="live shows streaming, whatever you pick">
        <fieldset disabled={!canEdit} className="relative m-0 border-0 p-0 disabled:opacity-60">
          <legend className="sr-only">presence</legend>
          <div role="presentation" className="grid grid-cols-3 gap-2">
            {PRESENCE_OPTIONS.map(({ choice: c, label, icon }) => (
              <OptionCard
                key={c}
                id={`presence-${c}`}
                name="presence"
                checked={c === choice}
                onChange={() => void setPresenceChoice(name, c)}
                picture={icon}
                label={label}
                stacked
              />
            ))}
          </div>
        </fieldset>
        <Status id="presence-note" text={presenceNote || (canEdit ? '' : whyNot)} quiet />
      </Block>

      <Block title="username" tip={me ? `once every ${RENAME_DAYS} days. the old one stays held for you` : undefined}>
        {me ? (
          <Rename me={me} />
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
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
                aria-label="name"
                placeholder="name"
                maxLength={24}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby="profile-name-hint"
                className={cn(INPUT, 'min-w-0 flex-1 basis-40')}
              />
              <Button id="profile-sign-up" size="sm" variant="outline" onClick={() => pickTab('security')}>
                sign up
              </Button>
            </div>
            <p id="profile-name-hint" className="mt-1 text-xs text-textTertiary">
              a-z 0-9 _ - · 24 max{nick && name !== nick ? ` · saved as ${name}` : ''}
            </p>
          </>
        )}
      </Block>

      {/* the status: one line about me, the way a custom status is. under my name on my page, beside it on home,
          in the sidebar and in the preview of my link. `bio` on the wire (the word `status` is the presence choice's) */}
      <Block title="status">
        <div className="flex gap-1.5">
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
            aria-label="status"
            placeholder="status"
            maxLength={MAX_BIO_CHARS}
            disabled={!canEdit}
            autoComplete="off"
            aria-describedby="profile-bio-count"
            className={cn(INPUT, 'min-w-0 flex-1')}
          />
          <span id="profile-bio-count" className={cn('self-center text-xs tabular-nums text-textTertiary', left < 20 && 'text-decrease')}>
            {left}
          </span>
          <Button id="profile-save-bio" size="sm" variant="outline" disabled={!canEdit} onClick={() => void saveMyBio()}>
            save
          </Button>
        </div>
        <Status id="profile-bio-status" text={bioStatus || (canEdit ? '' : whyNot)} quiet />
      </Block>

      {/* what the stream's page shows while I am not live: a picture where the player would be (the
          way twitch has an offline banner) and a line under the word. the picture is the card of a
          shared link too while I am off (docs/spec.md, "the watch document") */}
      <Block title="offline screen" tip="where the player goes while you're not live">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex shrink-0 flex-col gap-1.5">
            {/* the picture, or the dashed box where it would go, is the click for a new one, the way a group's banner is */}
            <div className="group/offline relative w-40">
              {offline !== null ? (
                <img
                  id="profile-offline-preview"
                  src={api.offlineUrl(name, offline)}
                  alt=""
                  draggable={false}
                  className="aspect-video w-full border border-primaryStroke bg-black object-cover"
                />
              ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 border border-dashed border-secondaryStroke text-xs text-textTertiary">
                  <RiCameraLine aria-hidden size={18} className="[@media(hover:none)]:hidden" />
                  16:9
                </div>
              )}
              {canEdit && (
                <PicturePick
                  id="profile-offline-file"
                  label="change picture"
                  icon={16}
                  reveal="group-hover/offline:opacity-100"
                  className="inset-0"
                  onPick={(file) => void saveMyOffline(file)}
                />
              )}
            </div>
            {offline !== null && (
              <Button id="profile-offline-remove" size="sm" variant="outline-danger" className="self-start" disabled={!canEdit} onClick={() => void removeMyOffline()}>
                remove
              </Button>
            )}
          </div>
          <div className="flex min-w-0 flex-1 basis-48 gap-1.5 self-center">
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
              aria-label="offline note"
              placeholder="note"
              maxLength={MAX_OFFLINE_NOTE_CHARS}
              disabled={!canEdit}
              autoComplete="off"
              aria-describedby="profile-offline-note-count"
              className={cn(INPUT, 'min-w-0 flex-1')}
            />
            <span id="profile-offline-note-count" className={cn('self-center text-xs tabular-nums text-textTertiary', noteLeft < 10 && 'text-decrease')}>
              {noteLeft}
            </span>
            <Button id="profile-save-offline-note" size="sm" variant="outline" disabled={!canEdit} onClick={() => void saveMyOfflineNote()}>
              save
            </Button>
          </div>
        </div>
        <Status id="profile-offline-status" text={offlineStatus || (canEdit ? '' : whyNot)} quiet />
        <Status id="profile-offline-note-status" text={offlineNoteStatus} quiet />
      </Block>

      {/* the chat welcome (WelcomeEditor.tsx), the same editor as my page's mod tab */}
      <Block id="profile-welcome-block" title="welcome message" tip={WELCOME_TIP}>
        <WelcomeEditor id="profile-welcome" />
      </Block>
    </div>
  );
}
