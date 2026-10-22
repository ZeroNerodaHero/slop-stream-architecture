import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { loadMe, logout, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom, reconnectChat, setNick } from '@/infra/atoms/chat-atoms';

/**
 * Who you are, in every page header. Logged in: your name and a log out.
 * Not logged in: a name box (localstorage, used in chat and as the go-live
 * default) and a link to log in. Nobody has to.
 */
export function UserBar() {
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

  if (me) {
    return (
      <span className="flex items-center gap-2 text-base">
        <span id="me" className="font-semibold">
          {me}
        </span>
        <span className="text-increase" title="logged in">
          ✓
        </span>
        <button id="logout" type="button" onClick={() => void logout()} className="text-textSecondary underline-offset-2 hover:underline">
          log out
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2 text-base">
      <label className="flex items-center gap-2 text-textSecondary">
        you
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
          maxLength={24}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-[150px] border border-primaryStroke bg-backgroundSecondary px-3 py-1.5 text-base text-textPrimary"
        />
      </label>
      <Link id="login-link" to={`/login?next=${encodeURIComponent(pathname)}`} className="text-textSecondary">
        log in
      </Link>
    </span>
  );
}
