import { RiLoginBoxLine, RiLogoutBoxRLine, RiSettings3Line, RiTerminalBoxLine, RiUserAddLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { loadMe, logout, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom, setNick } from '@/infra/atoms/chat-atoms';
import { closeAllDms, loadDms } from '@/infra/atoms/dm-atoms';
import { forgetFollowing, friendsOpenAtom, loadFollowing, streamingFriendsAtom } from '@/infra/atoms/follow-atoms';
import { openInspector } from '@/infra/atoms/inspector-atoms';
import { forgetNotifications, loadNotifications } from '@/infra/atoms/notification-atoms';
import { myPresenceAtom, PRESENCE_SQUARE, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { identityChanged, loadMyProfile, myAvatarVersionAtom, myNameAtom } from '@/infra/atoms/profile-atoms';
import { inspectorEnabledAtom, panelSideAtom } from '@/infra/atoms/settings-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { isValidName } from '@/infra/names';
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
/** Your picture: one box, a blue stroke when pointed at or focused. No shadow. A flex box, so a link lays the picture out the way the button did (no line box under it). */
const YOU =
  'relative inline-flex shrink-0 border border-transparent transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none';
/** The dot between two actions. */
function Dot() {
  return (
    <span aria-hidden className="mx-1.5 text-textTertiary">
      ·
    </span>
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

/**
 * The gear: the user modal (profile, groups, security; settings, appearance), opened on settings.
 * The far end of the actions line, away from the picture. The opener takes focus first, so the
 * browser has somewhere to hand it back (safari does not focus a clicked button), and the
 * panel closes under the dialog.
 */
function SettingsOpener({ className }: { className?: string }) {
  return (
    <button
      id="settings"
      type="button"
      aria-label="settings"
      aria-haspopup="dialog"
      title="settings"
      onClick={(e) => {
        e.currentTarget.focus();
        store.set(friendsOpenAtom, false);
        openUserModal('settings');
      }}
      className={cn(ACTION, 'align-middle hover:no-underline', className)}
    >
      <RiSettings3Line aria-hidden size={ICON} />
    </button>
  );
}

/**
 * A column beside every page (left, or the right from settings). Collapsed it is only as wide as
 * the pictures, and the streams use the rest: the search box as its icon, then friends, a line,
 * then the rest of who you follow (Friends.tsx), you at the bottom. Hover or focus widens it
 * over the streams (the page does not move, and neither do the pictures): the box, and beside
 * each picture the name, how they are, unfollow, chat for a friend, and your actions. Logged
 * in: your account name, a ✓, and log out under it. Not logged in: a name box (localstorage,
 * used in chat and as the go-live default) that reads as plain text until you point at it, with
 * sign up and log in under it. Nobody has to. The picture, and a login's name, are the way to
 * your own page, `/watch/<you>`: your status, your about me, your links, your calendar as everyone sees them (the about me and the links are written there too); the
 * gear at the far end of the actions line is the way to the user modal (profile, groups,
 * security, settings, appearance). The `chat` button that brings the friend chat window back is
 * the end of the friends line (Friends.tsx). Go live is the right end of the page's title row.
 * The ids are the ones the tests key on; `data-open` says which state the panel is in.
 */
export function UserPanel() {
  const me = useAtomValue(meAtom);
  const nick = useAtomValue(nickAtom);
  const myName = useAtomValue(myNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const presence = useAtomValue(myPresenceAtom);
  const inspectorOn = useAtomValue(inspectorEnabledAtom);
  const side = useAtomValue(panelSideAtom);
  const streaming = useAtomValue(streamingFriendsAtom);
  const { pathname } = useLocation();
  const panel = useRef<HTMLElement | null>(null);
  // the nick as it was when the box got focus: leaving it tells the chat only on a real change
  const nickAtFocus = useRef('');
  // the box over the panel (docs/follows.md): hovered or focused it is there
  const friendsOpen = useAtomValue(friendsOpenAtom);
  const leaving = useRef<number | null>(null);
  // the pointer is over the panel: losing focus then (a click on a line of words in it) is not leaving
  const hovered = useRef(false);

  // Mount only. Asks /api/me once per page load, then loads my picture; every later mount reuses the answer.
  useEffect(() => {
    void loadMe().then(loadMyProfile);
  }, []);

  // who I follow, my chats and my inbox: a login's, once the login is known and whenever it changes (in,
  // out, a rename). the watch page's follow button and the number on the corner read the first; the chat
  // window the second; the bell at the top right the third. another login's are not this one's, and a
  // guest has none.
  useEffect(() => {
    forgetFollowing();
    closeAllDms();
    forgetNotifications();
    if (me) {
      void loadFollowing();
      void loadDms();
      void loadNotifications();
    }
  }, [me]);

  // a page change closes the box: a friend's name was clicked, or the back button
  useEffect(() => {
    store.set(friendsOpenAtom, false);
  }, [pathname]);

  // closed with focus still inside (Escape, a page change): the box and the rows are in the
  // closed column now, and typing into a box with no room would show nothing. focus lets go
  useEffect(() => {
    if (friendsOpen) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== panel.current && panel.current?.contains(active)) active.blur();
  }, [friendsOpen]);

  function stayOpen() {
    if (leaving.current !== null) {
      window.clearTimeout(leaving.current);
      leaving.current = null;
    }
    if (!friendsOpen) store.set(friendsOpenAtom, true);
  }
  function leaveSoon() {
    // typing in the box, or tabbing along the rows: the pointer leaving does not close it. a click elsewhere takes the focus, and that does
    const active = document.activeElement;
    if (active && active !== panel.current && panel.current?.contains(active)) return;
    if (leaving.current !== null) window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => {
      leaving.current = null;
      store.set(friendsOpenAtom, false);
    }, LEAVE_GRACE_MS);
  }
  function closeFriends() {
    store.set(friendsOpenAtom, false);
  }

  if (me === undefined) return null;
  const next = encodeURIComponent(pathname);
  // on the right the panel grows leftward, so the row is mirrored and your picture stays at the edge, like the rows above it
  const mirrored = side === 'right';
  // where the picture goes: my page, once I have a name. a guest with none yet gets the profile tab, where the name box is
  const myPage = isValidName(myName) ? `/watch/${myName}` : null;
  const youLabel = `you: ${myPage ? 'your page' : 'pick a name'}. ${PRESENCE_WORD[presence]}${streaming > 0 ? `. ${streaming} streaming` : ''}`;
  const youTitle = `${myPage ? 'your page' : 'pick a name'} · ${PRESENCE_WORD[presence]}`;
  const face = (
    <>
      <Face name={me ?? nick} version={avatar} />
      {/* the presence square in the corner of the picture: blue streaming, green online, red do not
          disturb, grey offline (docs/status.md). the word is in the label; the ✓ keeps meaning login */}
      <span
        id="my-presence"
        aria-hidden
        data-presence={presence}
        className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-background', PRESENCE_SQUARE[presence])}
      />
      {/* how many of them are live, on the picture's corner: the one number the closed column shows */}
      {streaming > 0 && (
        <span
          id="friends-streaming"
          aria-hidden
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center border border-background bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background"
        >
          {streaming}
        </span>
      )}
    </>
  );

  return (
    <aside
      ref={panel}
      id="user-panel"
      aria-label="you"
      data-side={side}
      data-open={friendsOpen}
      onMouseEnter={() => {
        hovered.current = true;
        stayOpen();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        leaveSoon();
      }}
      onFocusCapture={stayOpen}
      onBlurCapture={(e) => {
        // focus went somewhere outside the panel and its list, or nowhere, and the pointer is not here either
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !hovered.current) leaveSoon();
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
          friendsOpen ? EXPANDED : COLLAPSED
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <Friends open={friendsOpen} side={side} onPick={closeFriends} />
        </div>
        {/* your picture 19px in from the edge, open or closed: centered in the closed column, in line with the faces above. the
            name block beside it is in the row closed too, invisible, so the row is one height in both states and the lists
            above have the same room (Friends.tsx cuts them at whole rows of it) */}
        <div className={cn('flex shrink-0 items-center gap-2 border-t border-primaryStroke py-2.5', mirrored ? 'flex-row-reverse pl-3 pr-[19px]' : 'pl-[19px] pr-3')}>
          {/* the picture is a link to your own page, the way every face above is a link to theirs. not draggable: it must not lift off as a ghost */}
          {myPage ? (
            <Link id="you" to={myPage} aria-label={youLabel} title={youTitle} draggable={false} onClick={closeFriends} className={YOU}>
              {face}
            </Link>
          ) : (
            <button
              id="you"
              type="button"
              aria-label={youLabel}
              aria-haspopup="dialog"
              title={youTitle}
              onClick={(e) => {
                e.currentTarget.focus();
                closeFriends();
                openUserModal('profile');
              }}
              className={YOU}
            >
              {face}
            </button>
          )}

          {me ? (
            <>
              <span className={cn('min-w-0 flex-1 whitespace-nowrap', mirrored && 'text-right', !friendsOpen && 'invisible')}>
                {/* a login's name is a second way to your page. #me stays the bare name, for the tests, even while the panel is closed */}
                <Link
                  to={`/watch/${me}`}
                  title="your page"
                  draggable={false}
                  onClick={closeFriends}
                  className={cn(
                    NAME_LINE,
                    'flex w-full items-center gap-1.5 text-left hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none',
                    mirrored && 'flex-row-reverse text-right'
                  )}
                >
                  <span id="me" className="truncate font-semibold">
                    {me}
                  </span>
                  <span className="shrink-0 text-increase" title="logged in: this name is yours">
                    ✓
                  </span>
                </Link>
                {/* leading-5, not tight: tight is 17.5px on text-sm, and a half pixel here puts the whole footer, and the column over it, off the pixel grid.
                    a flex row, so the gear sits at the far end, away from the picture on either side */}
                <span className={cn('flex items-center text-sm leading-5', mirrored && 'flex-row-reverse')}>
                  <button id="logout" type="button" onClick={() => void logout().then(() => identityChanged('login'))} className={ACTION}>
                    <RiLogoutBoxRLine aria-hidden size={ICON} />
                    log out
                  </button>
                  {inspectorOn && (
                    <>
                      <Dot />
                      <InspectorOpener />
                    </>
                  )}
                  <SettingsOpener className={mirrored ? 'mr-auto' : 'ml-auto'} />
                </span>
              </span>
            </>
          ) : (
            <>
              <span className={cn('min-w-0 flex-1 whitespace-nowrap', mirrored && 'text-right', !friendsOpen && 'invisible')}>
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
                      'mx-0 w-full truncate bg-transparent font-semibold text-textPrimary placeholder:font-normal placeholder:text-textTertiary hover:border-primaryStroke focus:border-primaryBlue focus:bg-background',
                      mirrored ? 'pl-6 text-right' : 'pr-6'
                    )}
                  />
                  <span
                    aria-hidden
                    className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-sm text-textTertiary', mirrored ? 'left-1.5' : 'right-1.5')}
                  >
                    ✎
                  </span>
                </span>
                {/* the way to make the name yours, right under it; the gear at the far end */}
                <span className={cn('flex items-center text-sm leading-5 text-textSecondary', mirrored && 'flex-row-reverse')}>
                  <Link id="signup-link" to={`/signup?next=${next}`} className={ACTION}>
                    <RiUserAddLine aria-hidden size={ICON} />
                    sign up
                  </Link>
                  <Dot />
                  <Link id="login-link" to={`/login?next=${next}`} className={ACTION}>
                    <RiLoginBoxLine aria-hidden size={ICON} />
                    log in
                  </Link>
                  {inspectorOn && (
                    <>
                      <Dot />
                      <InspectorOpener />
                    </>
                  )}
                  <SettingsOpener className={mirrored ? 'mr-auto' : 'ml-auto'} />
                </span>
              </span>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
