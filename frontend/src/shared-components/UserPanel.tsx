import { RiLoginBoxLine, RiLogoutBoxRLine, RiTerminalBoxLine, RiUserAddLine, RiUserFollowLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { loadMe, logout, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom, setNick } from '@/infra/atoms/chat-atoms';
import { closeDm } from '@/infra/atoms/dm-atoms';
import { followingAtom, forgetFollowing, friendsOpenAtom, loadFollowing, streamingFriendsAtom } from '@/infra/atoms/follow-atoms';
import { openInspector } from '@/infra/atoms/inspector-atoms';
import { type Presence, myPresenceAtom, PRESENCE_SQUARE, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { identityChanged, loadMyProfile, myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { inspectorEnabledAtom, panelSideAtom } from '@/infra/atoms/settings-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { store } from '@/infra/store';
import { Face } from '@/shared-components/Face';
import { Friends } from '@/shared-components/Friends';
import { cn } from '@/utils/cn';

/** Closed: a column of pictures. Open: wide enough for the names. The page sits in what's left. */
const COLLAPSED = 'w-20';
const EXPANDED = 'w-[min(360px,calc(100vw-12rem))]';

/** How long the pointer may be off the panel before the sidebar closes. Room to reach the chat window. */
const LEAVE_GRACE_MS = 250;

/** The name line in both states: the same box, so logging in or out does not move anything. */
const NAME_LINE = '-mx-1 block border border-transparent px-1 py-0.5 leading-tight';
/** The small links under the name: a remix icon and a word. */
const ACTION = 'inline-flex shrink-0 items-center gap-1 text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline';
const ICON = 14;
/** The dot between two actions. */
function Dot() {
  return (
    <span aria-hidden className="mx-1.5 text-textTertiary">
      ·
    </span>
  );
}

/** One followed person, as the closed sidebar shows them: the picture and the presence square. */
function RailFace({ name, avatar, presence }: { name: string; avatar: number | null; presence: Presence }) {
  return (
    <span className="relative block border border-transparent" title={`${name} · ${PRESENCE_WORD[presence]}`}>
      <Face name={name} version={avatar} />
      <span aria-hidden data-presence={presence} className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-background', PRESENCE_SQUARE[presence])} />
    </span>
  );
}

/**
 * Who you follow, while the sidebar is closed: pictures only, friends above the rest, the same
 * order the open list uses. Not a control. Pointing at the panel opens the names.
 */
function PeopleRail() {
  const list = useAtomValue(followingAtom);
  if (!list || list.length === 0) return null;
  const friends = list.filter((f) => f.mutual);
  const following = list.filter((f) => !f.mutual);
  return (
    <div aria-hidden className="pointer-events-none flex w-full flex-col items-center gap-2 px-2 py-2.5">
      {friends.length > 0 && (
        <ul className="flex flex-col gap-2">
          {friends.map((f) => (
            <li key={f.name}>
              <RailFace name={f.name} avatar={f.avatar} presence={f.presence} />
            </li>
          ))}
        </ul>
      )}
      {friends.length > 0 && following.length > 0 && <span className="mx-auto h-px w-6 bg-primaryStroke" />}
      {following.length > 0 && (
        <ul className="flex flex-col gap-2">
          {following.map((f) => (
            <li key={f.name}>
              <RailFace name={f.name} avatar={f.avatar} presence={f.presence} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The messages inspector, one click from every page while its setting is on (docs/status.md). An icon alone: the line is full. */
function InspectorOpener() {
  return (
    <button
      id="inspector-open"
      type="button"
      aria-label="messages"
      title="messages: the frames this browser gets"
      onClick={openInspector}
      className={cn(ACTION, 'align-middle hover:no-underline')}
    >
      <RiTerminalBoxLine aria-hidden size={ICON} />
    </button>
  );
}

/** The picture (or the name, for a login) is the way into the user modal: the opener takes focus first, so the browser has somewhere to hand it back (safari does not focus a clicked button). */
function openProfile(e: { currentTarget: HTMLElement }) {
  e.currentTarget.focus();
  store.set(friendsOpenAtom, false);
  openUserModal('profile');
}

/** The way into the box over the panel without a mouse: a word, and how many of them are streaming. */
function FriendsOpener({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const streaming = useAtomValue(streamingFriendsAtom);
  return (
    <button
      id="friends-open"
      type="button"
      aria-expanded={open}
      aria-controls="friends"
      title={streaming > 0 ? `following: ${streaming} streaming` : 'who you follow, and finding more'}
      onClick={onToggle}
      className={ACTION}
    >
      <RiUserFollowLine aria-hidden size={ICON} />
      following
      {streaming > 0 && (
        <span id="friends-streaming" className="font-semibold text-primaryBlue">
          {streaming}
        </span>
      )}
    </button>
  );
}

/**
 * A column beside every page (left, or the right from settings). Collapsed it is only as wide as
 * the pictures, and the streams use the rest. Hover, focus, or the `following` button widens it
 * over the streams (the page does not move): names, unfollow, chat for a friend, and your
 * actions. Logged in: your account name, a ✓, and log out under it. Not logged in: a name box
 * (localstorage, used in chat and as the go-live default) that reads as plain text until you
 * point at it, with sign up and log in under it. Nobody has to. The picture, and a login's name,
 * open the user modal (profile, security, settings, appearance). Go live and the settings icon
 * sit at the right of the centered search, over the page. The ids are the ones the tests key on.
 */
export function UserPanel() {
  const me = useAtomValue(meAtom);
  const nick = useAtomValue(nickAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const presence = useAtomValue(myPresenceAtom);
  const inspectorOn = useAtomValue(inspectorEnabledAtom);
  const side = useAtomValue(panelSideAtom);
  const streaming = useAtomValue(streamingFriendsAtom);
  const { pathname } = useLocation();
  // the nick as it was when the box got focus: leaving it tells the chat only on a real change
  const nickAtFocus = useRef('');
  // the box over the panel (docs/follows.md): hovered or focused it is there; the button pins it
  const friendsOpen = useAtomValue(friendsOpenAtom);
  // pinned by its button: the mouse leaving does not close it. a ref: it changes what a leave does, not what renders
  const pinned = useRef(false);
  const [byKey, setByKey] = useState(false);
  const leaving = useRef<number | null>(null);

  // Mount only. Asks /api/me once per page load, then loads my picture; every later mount reuses the answer.
  useEffect(() => {
    void loadMe().then(loadMyProfile);
  }, []);

  // who I follow: a login's list, once the login is known and whenever it changes (in, out, a rename).
  // the watch page's follow button and the number on the corner read it. a guest has no chat window.
  useEffect(() => {
    forgetFollowing();
    if (me) void loadFollowing();
    if (me === null) closeDm();
  }, [me]);

  // a page change closes the box: a friend's name was clicked, or the back button
  useEffect(() => {
    store.set(friendsOpenAtom, false);
    pinned.current = false;
  }, [pathname]);

  function stayOpen() {
    if (leaving.current !== null) {
      window.clearTimeout(leaving.current);
      leaving.current = null;
    }
    if (!friendsOpen) {
      setByKey(false);
      store.set(friendsOpenAtom, true);
    }
  }
  function leaveSoon() {
    if (pinned.current) return;
    if (leaving.current !== null) window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => {
      leaving.current = null;
      store.set(friendsOpenAtom, false);
    }, LEAVE_GRACE_MS);
  }
  function closeFriends() {
    pinned.current = false;
    store.set(friendsOpenAtom, false);
  }
  function toggleFriends() {
    if (friendsOpen && pinned.current) {
      closeFriends();
      return;
    }
    setByKey(true);
    pinned.current = true;
    store.set(friendsOpenAtom, true);
  }

  if (me === undefined) return null;
  const next = encodeURIComponent(pathname);

  return (
    <aside
      id="user-panel"
      aria-label="you"
      data-side={side}
      onMouseEnter={stayOpen}
      onMouseLeave={leaveSoon}
      onFocusCapture={stayOpen}
      onBlurCapture={(e) => {
        // focus went somewhere outside the panel and its list
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leaveSoon();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && friendsOpen) {
          e.stopPropagation();
          closeFriends();
        }
      }}
      className={cn('sticky top-0 h-screen w-20 shrink-0 self-start', friendsOpen && 'z-40')}
    >
      {/* the column stays this wide in the page. open, the panel grows out of it and covers the streams */}
      <div
        className={cn(
          'absolute top-0 flex h-full flex-col overflow-hidden bg-background text-base transition-[width] duration-150',
          side === 'right' ? 'right-0 border-l border-primaryStroke' : 'left-0 border-r border-primaryStroke',
          friendsOpen ? cn(EXPANDED, 'shadow-hard') : COLLAPSED
        )}
      >
        <div className={cn('flex min-h-0 flex-1 flex-col', !friendsOpen && 'overflow-y-auto')}>
          {friendsOpen ? <Friends onClose={closeFriends} focusSearch={byKey} /> : <PeopleRail />}
        </div>
        <div className={cn('flex shrink-0 items-center gap-3 border-t border-primaryStroke py-2.5', friendsOpen ? 'px-3' : 'justify-center px-2')}>
          <button
            id="you"
            type="button"
            aria-label={`you: profile and settings. ${PRESENCE_WORD[presence]}${streaming > 0 ? `. ${streaming} streaming` : ''}`}
            aria-haspopup="dialog"
            title={`profile and settings · ${PRESENCE_WORD[presence]}`}
            onClick={openProfile}
            className="relative shrink-0 border border-transparent transition-[border-color,box-shadow] duration-150 hover:border-primaryBlue hover:shadow-hard-blue focus-visible:border-primaryBlue focus-visible:shadow-hard-blue focus-visible:outline-none"
          >
            <Face name={me ?? nick} version={avatar} />
            {/* the presence square in the corner of the picture: blue streaming, green online, red do not
            disturb, grey offline (docs/status.md). the word is in the button's label; the ✓ keeps meaning login */}
            <span
              id="my-presence"
              aria-hidden
              data-presence={presence}
              className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-background', PRESENCE_SQUARE[presence])}
            />
            {/* how many of them are live, while the list itself is closed */}
            {!friendsOpen && streaming > 0 && (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center border border-background bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background"
              >
                {streaming}
              </span>
            )}
          </button>

          {me ? (
            <>
              <span className={cn('min-w-0 flex-1', !friendsOpen && 'hidden')}>
                {/* a login's name is a second way in. #me stays the bare name, for the tests, even while the panel is closed */}
                <button
                  type="button"
                  aria-haspopup="dialog"
                  title="profile and settings"
                  onClick={openProfile}
                  className={cn(
                    NAME_LINE,
                    'flex w-full items-center gap-1.5 text-left hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none'
                  )}
                >
                  <span id="me" className="truncate font-semibold">
                    {me}
                  </span>
                  <span className="shrink-0 text-increase" title="logged in: this name is yours">
                    ✓
                  </span>
                </button>
                <span className="block text-sm leading-tight">
                  <button id="logout" type="button" onClick={() => void logout().then(() => identityChanged('login'))} className={ACTION}>
                    <RiLogoutBoxRLine aria-hidden size={ICON} />
                    log out
                  </button>
                  <Dot />
                  <FriendsOpener open={friendsOpen} onToggle={toggleFriends} />
                  {inspectorOn && (
                    <>
                      <Dot />
                      <InspectorOpener />
                    </>
                  )}
                </span>
              </span>
            </>
          ) : (
            <>
              <span className={cn('min-w-0 flex-1', !friendsOpen && 'hidden')}>
                <label htmlFor="username" className="sr-only">
                  your name
                </label>
                {/* a guest's name is the box: clicking it edits, it does not open anything */}
                <span className="relative -mx-1 block">
                  <input
                    id="username"
                    value={nick}
                    onChange={(e) => setNick(e.target.value)}
                    onFocus={(e) => {
                      nickAtFocus.current = e.currentTarget.value;
                    }}
                    onBlur={(e) => {
                      // a reconnect replaces the history and blips the count for the whole room: only for a new name
                      if (e.currentTarget.value !== nickAtFocus.current) identityChanged('nick', nickAtFocus.current);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    placeholder="pick a name"
                    title="your name. click to change it"
                    maxLength={24}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className={cn(
                      NAME_LINE,
                      // the border shows on hover and goes blue on focus (said here too: the hover rule outranks the one in globals.css)
                      'mx-0 w-full truncate bg-transparent pr-6 font-semibold text-textPrimary placeholder:font-normal placeholder:text-textTertiary hover:border-primaryStroke focus:border-primaryBlue focus:bg-background'
                    )}
                  />
                  <span aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-sm text-textTertiary">
                    ✎
                  </span>
                </span>
                {/* the way to make the name yours, right under it */}
                <span className="block text-sm leading-tight text-textSecondary">
                  <Link id="signup-link" to={`/signup?next=${next}`} className={ACTION}>
                    <RiUserAddLine aria-hidden size={ICON} />
                    sign up
                  </Link>
                  <Dot />
                  <Link id="login-link" to={`/login?next=${next}`} className={ACTION}>
                    <RiLoginBoxLine aria-hidden size={ICON} />
                    log in
                  </Link>
                  <Dot />
                  <FriendsOpener open={friendsOpen} onToggle={toggleFriends} />
                  {inspectorOn && (
                    <>
                      <Dot />
                      <InspectorOpener />
                    </>
                  )}
                </span>
              </span>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
