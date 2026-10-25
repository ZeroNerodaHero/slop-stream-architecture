import { RiLoginBoxLine, RiLogoutBoxRLine, RiSettings3Line, RiTerminalBoxLine, RiUserAddLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { loadMe, logout, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom, setNick } from '@/infra/atoms/chat-atoms';
import { openInspector } from '@/infra/atoms/inspector-atoms';
import { myPresenceAtom, PRESENCE_SQUARE, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { identityChanged, loadMyProfile, myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { inspectorEnabledAtom } from '@/infra/atoms/settings-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { buttonClassName } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { panelClassName } from '@/shared-components/Panel';
import { cn } from '@/utils/cn';

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
  openUserModal('profile');
}

/**
 * Who you are, pinned to the bottom left corner of every page the way discord does it: a
 * picture, your name in bold, a small line under it saying how you are here, and the actions
 * on the right. Logged in: your account name, a ✓, and log out under it. Not logged in: a
 * name box (localstorage, used in chat and as the go-live default) that reads as plain text
 * until you point at it, with sign up and log in under it. Nobody has to. The picture, and a
 * login's name, open the user modal (profile, security, settings, appearance); the gear that
 * ends the actions line opens it on settings. "go live" is the one thing on the right, on
 * every page but its own. The ids are the ones the tests key on.
 */
export function UserPanel() {
  const me = useAtomValue(meAtom);
  const nick = useAtomValue(nickAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const presence = useAtomValue(myPresenceAtom);
  const inspectorOn = useAtomValue(inspectorEnabledAtom);
  const { pathname } = useLocation();
  // the nick as it was when the box got focus: leaving it tells the chat only on a real change
  const nickAtFocus = useRef('');

  // Mount only. Asks /api/me once per page load, then loads my picture; every later mount reuses the answer.
  useEffect(() => {
    void loadMe().then(loadMyProfile);
  }, []);

  if (me === undefined) return null;
  const next = encodeURIComponent(pathname);
  const onLivePage = pathname.replace(/\/$/, '') === '/live';
  const goLive = !onLivePage && (
    <Link id="go-live" to="/live" className={buttonClassName('primary', 'px-3 py-1.5 text-sm')}>
      go live
    </Link>
  );

  return (
    <aside
      id="user-panel"
      aria-label="you"
      className={panelClassName('fixed bottom-6 left-6 z-40 flex w-[min(360px,calc(100vw-3rem))] items-center gap-3 px-3 py-2.5 text-base')}
    >
      <button
        id="you"
        type="button"
        aria-label={`you: profile and settings. ${PRESENCE_WORD[presence]}`}
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
          className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-backgroundSecondary', PRESENCE_SQUARE[presence])}
        />
      </button>

      {me ? (
        <>
          <span className="min-w-0 flex-1">
            {/* a login's name is a second way in. #me stays the bare name, for the tests */}
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
              <button id="settings" type="button" onClick={() => openUserModal('settings')} className={ACTION}>
                <RiSettings3Line aria-hidden size={ICON} />
                settings
              </button>
              {inspectorOn && (
                <>
                  <Dot />
                  <InspectorOpener />
                </>
              )}
            </span>
          </span>
          {goLive}
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1">
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
              {/* the gear alone: three words and three icons would not fit this line */}
              <button
                id="settings"
                type="button"
                aria-label="settings"
                title="settings"
                onClick={() => openUserModal('settings')}
                className={cn(ACTION, 'align-middle hover:no-underline')}
              >
                <RiSettings3Line aria-hidden size={ICON} />
              </button>
              {inspectorOn && (
                <>
                  <Dot />
                  <InspectorOpener />
                </>
              )}
            </span>
          </span>
          {goLive}
        </>
      )}
    </aside>
  );
}
