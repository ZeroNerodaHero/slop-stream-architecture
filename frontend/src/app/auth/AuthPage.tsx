import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { authBusyAtom, authErrorAtom, clearAuthError, login, meAtom, signup } from '@/infra/atoms/auth-atoms';
import { identityChanged } from '@/infra/atoms/profile-atoms';
import { Button } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';

interface AuthPageProps {
  mode: 'login' | 'signup';
}

const INPUT = 'w-full border border-primaryStroke bg-backgroundSecondary px-4 py-3 text-textPrimary';

/**
 * Where to go after. Only a path on this site, so the `next` param cannot send you
 * elsewhere: not `//host`, not `/\host` (browsers read a backslash there as a slash),
 * not a full url. The resolved origin is checked too, so the regex is not the only wall.
 */
function nextFrom(params: URLSearchParams): string {
  const next = params.get('next') ?? '/';
  if (!/^\/(?![/\\])/.test(next)) return '/';
  try {
    return new URL(next, location.origin).origin === location.origin ? next : '/';
  } catch {
    return '/';
  }
}

/**
 * /login and /signup, one form: a name, a password, a button. The password
 * goes to the api as typed, over https; the api hashes it. See docs/accounts.md.
 * The autocomplete values are what make password managers offer to save it.
 */
export function AuthPage({ mode }: AuthPageProps) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useAtomValue(meAtom);
  const busy = useAtomValue(authBusyAtom);
  const error = useAtomValue(authErrorAtom);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const next = nextFrom(params);
  const signingUp = mode === 'signup';

  // Mount only: a stale error from a previous visit should not greet you here.
  // The links between the two modes clear it too (same component, no remount).
  useEffect(() => {
    clearAuthError();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await (signingUp ? signup(name, password) : login(name, password));
    if (ok) {
      // the events socket is who the browser is: say hello again as the login, so the name reads
      // online to everyone (the security tab's login does the same). without it the socket stays
      // nobody until the next full page load
      identityChanged('login');
      navigate(next, { replace: true });
    }
  }

  return (
    <PageFrame title={signingUp ? 'sign up' : 'log in'}>
      {me ? (
        <p className="text-textSecondary">
          you are logged in as <span className="font-semibold text-textPrimary">{me}</span>.{' '}
          <Link to={next} className="text-primaryBlue">
            carry on
          </Link>
        </p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="max-w-[420px]">
          <label htmlFor="auth-name" className="text-textSecondary">
            name
          </label>
          <input
            id="auth-name"
            name="username"
            value={name}
            onChange={(e) =>
              setName(
                e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]/g, '')
                  .slice(0, 32)
              )
            }
            placeholder="a-z 0-9 _ -"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={32}
            required
            className={`${INPUT} mb-4 mt-1`}
          />

          <label htmlFor="auth-password" className="text-textSecondary">
            password {signingUp && <span className="text-textTertiary">(8 or more, anything goes)</span>}
          </label>
          <div className="relative mt-1">
            <input
              id="auth-password"
              name="password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              minLength={signingUp ? 8 : undefined}
              maxLength={128}
              required
              className={`${INPUT} pr-20`}
            />
            <button
              id="auth-show"
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-textSecondary underline-offset-2 hover:underline"
            >
              {show ? 'hide' : 'show'}
            </button>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-4">
            <Button id="auth-submit" type="submit" variant="primary" disabled={busy || !name || !password}>
              {signingUp ? 'make the account' : 'log in'}
            </Button>
            {signingUp ? (
              <Link to={`/login?next=${encodeURIComponent(next)}`} onClick={clearAuthError} className="text-textSecondary">
                have one? log in
              </Link>
            ) : (
              <Link to={`/signup?next=${encodeURIComponent(next)}`} onClick={clearAuthError} className="text-textSecondary">
                new here? sign up
              </Link>
            )}
          </div>

          <p id="auth-error" className="mt-4 min-h-[1.5em] text-decrease" aria-live="polite">
            {error}
          </p>

          <p className="mt-6 text-sm text-textTertiary">
            an account keeps your name yours: only you can go live, edit the bio or talk as it. there is no email and no reset, so remember it. nobody has to sign up to
            watch, chat or stream under a free name.
          </p>
        </form>
      )}
    </PageFrame>
  );
}
