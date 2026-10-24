import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { loadMe, logout, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom, reconnectChat, setNick } from '@/infra/atoms/chat-atoms';
import { buttonClassName } from '@/shared-components/Button';
import { GeneratedAvatar } from '@/shared-components/GeneratedAvatar';
import { panelClassName } from '@/shared-components/Panel';
import { cn } from '@/utils/cn';

/** The name line in both states: the same box, so logging in or out does not move anything. */
const NAME_LINE = '-mx-1 block border border-transparent px-1 py-0.5 leading-tight';
const ACTION = 'shrink-0 text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline';

/**
 * Who you are, pinned to the bottom left corner of every page the way discord does it: a
 * picture, your name in bold, a small line under it saying how you are here, and the actions
 * on the right. Logged in: your account name, a ✓, and log out under it. Not logged in: a
 * name box (localstorage, used in chat and as the go-live default) that reads as plain text
 * until you point at it, with sign up and log in under it. Nobody has to. "go live" is the one
 * thing on the right, on every page but its own. The picture is made from the name
 * (GeneratedAvatar) for now; the ids are the ones the tests key on.
 */
export function UserPanel() {
  const me = useAtomValue(meAtom);
  const nick = useAtomValue(nickAtom);
  const { pathname } = useLocation();
  // the nick as it was when the box got focus: leaving it reconnects chat only on a real change
  const nickAtFocus = useRef('');

  // Mount only. Asks /api/me once per page load; every later mount reuses the answer.
  useEffect(() => {
    void loadMe();
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
      className={panelClassName('fixed bottom-6 left-6 z-40 flex w-[min(340px,calc(100vw-3rem))] items-center gap-3 px-3 py-2.5 text-base')}
    >
      <span className="relative shrink-0">
        <GeneratedAvatar name={me ?? nick} />
        {/* the presence square in the corner of the picture: green for a login, grey for a guest */}
        <span aria-hidden className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-backgroundSecondary', me ? 'bg-increase' : 'bg-textTertiary')} />
      </span>

      {me ? (
        <>
          <span className="min-w-0 flex-1">
            <span className={cn(NAME_LINE, 'flex items-center gap-1.5')}>
              <span id="me" className="truncate font-semibold">
                {me}
              </span>
              <span className="shrink-0 text-increase" title="logged in: this name is yours">
                ✓
              </span>
            </span>
            <span className="block text-sm leading-tight">
              <button id="logout" type="button" onClick={() => void logout()} className={ACTION}>
                log out
              </button>
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
                  if (e.currentTarget.value !== nickAtFocus.current) reconnectChat();
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
                sign up
              </Link>
              <span aria-hidden className="mx-1.5 text-textTertiary">
                ·
              </span>
              <Link id="login-link" to={`/login?next=${next}`} className={ACTION}>
                log in
              </Link>
            </span>
          </span>
          {goLive}
        </>
      )}
    </aside>
  );
}
