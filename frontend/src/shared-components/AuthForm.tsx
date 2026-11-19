import { RiCheckLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useState } from 'react';

import { type AuthMode, authBusyAtom, authErrorAtom, clearAuthError, login, meAtom, signup } from '@/infra/atoms/auth-atoms';
import { identityChanged } from '@/infra/atoms/profile-atoms';
import { passwordChecks, passwordOk } from '@/infra/password';
import { Button } from '@/shared-components/Button';
import { BUTTON } from '@/shared-components/user-modal/parts';

interface AuthFormProps {
  mode: AuthMode;
  /** The "new here? sign up" / "have one? log in" words: the other form, in the same place. */
  onMode: (mode: AuthMode) => void;
  /** Logged in (or already were, and said carry on). */
  onDone: () => void;
}

const LABEL = 'text-sm font-semibold text-textSecondary';
const INPUT = 'w-full border border-primaryStroke bg-background px-3 py-2 text-base leading-snug text-textPrimary focus:border-primaryBlue';

/**
 * Log in and sign up, one form: a name, a password, a button. The password goes to the api as
 * typed, over https; the api hashes it. See docs/accounts.md. The autocomplete values are what
 * make password managers offer to save it. Shown in the auth dialog (AuthDialog.tsx), over
 * whatever page you were on; the security tab has its own.
 */
export function AuthForm({ mode, onMode, onDone }: AuthFormProps) {
  const me = useAtomValue(meAtom);
  const busy = useAtomValue(authBusyAtom);
  const error = useAtomValue(authErrorAtom);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const signingUp = mode === 'signup';
  // a new password's rule, ticked off under the box as it is typed; logging in asks none of it
  const checks = signingUp ? passwordChecks(password) : null;
  const unmet = checks !== null && !passwordOk(checks);

  // Mount only: a stale error from a previous try should not greet you here.
  // The switch between the two modes clears it too (same component, no remount).
  useEffect(() => {
    clearAuthError();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (unmet) return;
    const ok = await (signingUp ? signup(name, password) : login(name, password));
    if (ok) {
      // the events socket is who the browser is: say hello again as the login, so the name reads
      // online to everyone (the security tab's login does the same). without it the socket stays
      // nobody until the next full page load
      identityChanged('login');
      onDone();
    }
  }

  if (me) {
    return (
      <p className="mt-4 text-base text-textSecondary">
        you are logged in as <span className="font-semibold text-textPrimary">{me}</span>.{' '}
        <button type="button" onClick={onDone} className="font-semibold text-primaryBlue">
          carry on
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="auth-name" className={LABEL}>
          username
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
          className={INPUT}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="auth-password" className={LABEL}>
          password
        </label>
        <div className="relative">
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
            aria-invalid={password && unmet ? true : undefined}
            aria-describedby={checks ? 'auth-password-rules' : undefined}
            className={`${INPUT} pr-16`}
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
        {checks && (
          <ul id="auth-password-rules" aria-live="polite" className="mt-0.5 flex flex-col gap-0.5">
            <Rule ok={checks.length}>8–128 characters</Rule>
            <Rule ok={checks.number}>a number</Rule>
            <Rule ok={checks.symbol}>a symbol</Rule>
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button id="auth-submit" type="submit" variant="primary" className={BUTTON} disabled={busy || !name || !password || unmet}>
          {signingUp ? 'make the account' : 'log in'}
        </Button>
        <button
          id="auth-switch"
          type="button"
          onClick={() => {
            clearAuthError();
            onMode(signingUp ? 'login' : 'signup');
          }}
          className="text-base text-textSecondary underline-offset-2 hover:underline"
        >
          {signingUp ? 'have one? log in' : 'new here? sign up'}
        </button>
      </div>

      {error && (
        <p id="auth-error" role="alert" className="text-base text-decrease">
          {error}
        </p>
      )}
    </form>
  );
}

/** One part of the new password's rule: a box, ticked once the password meets it. */
function Rule({ ok, children }: { ok: boolean; children: string }) {
  return (
    <li className={`flex items-center gap-2 text-sm leading-5 ${ok ? 'text-textPrimary' : 'text-textSecondary'}`}>
      <span
        role="img"
        aria-label={ok ? 'met' : 'not yet'}
        className={`flex h-4 w-4 shrink-0 items-center justify-center border transition-colors duration-150 ${
          ok ? 'border-primaryBlue bg-primaryBlue text-background' : 'border-primaryStroke bg-background'
        }`}
      >
        {ok && <RiCheckLine aria-hidden size={12} />}
      </span>
      {children}
    </li>
  );
}
