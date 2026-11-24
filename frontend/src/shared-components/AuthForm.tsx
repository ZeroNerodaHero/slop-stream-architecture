import { RiCheckLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useState } from 'react';

import { type AuthMode, authBusyAtom, authErrorAtom, clearAuthError, login, meAtom, signup } from '@/infra/atoms/auth-atoms';
import { identityChanged } from '@/infra/atoms/profile-atoms';
import { passwordChecks, passwordOk } from '@/infra/password';
import { Button } from '@/shared-components/Button';
import { OAuthButtons } from '@/shared-components/OAuthButtons';
import { useTurnstile } from '@/shared-components/Turnstile';
import { INPUT } from '@/shared-components/input';
import { BUTTON } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

interface AuthFormProps {
  mode: AuthMode;
  onMode: (mode: AuthMode) => void;
  onDone: () => void;
}

const LABEL = 'text-sm font-semibold text-textSecondary';

export function AuthForm({ mode, onMode, onDone }: AuthFormProps) {
  const me = useAtomValue(meAtom);
  const busy = useAtomValue(authBusyAtom);
  const error = useAtomValue(authErrorAtom);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const signingUp = mode === 'signup';
  const checks = signingUp ? passwordChecks(password) : null;
  const unmet = checks !== null && !passwordOk(checks);
  const human = useTurnstile('auth-turnstile');

  useEffect(() => {
    clearAuthError();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (unmet || !human.ready) return;
    const ok = await (signingUp ? signup(name, password, human.token) : login(name, password, human.token));
    human.spent();
    if (ok) {
      identityChanged('login');
      onDone();
    }
  }

  if (me) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <p className="text-base text-textSecondary">
          you are logged in as <span className="font-semibold text-textPrimary">{me}</span>.
        </p>
        <Button size="sm" variant="outline" onClick={onDone}>
          carry on
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-col gap-3">
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
          placeholder="username"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={32}
          required
          aria-describedby="auth-name-hint"
          className={INPUT}
        />
        <p id="auth-name-hint" className="text-sm text-textTertiary">
          a-z 0-9 _ -
        </p>
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
            className={cn(INPUT, 'pr-16')}
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
          <ul id="auth-password-rules" aria-live="polite" className="flex flex-col gap-0.5">
            <Rule ok={checks.length}>8–128 characters</Rule>
            <Rule ok={checks.number}>a number</Rule>
            <Rule ok={checks.symbol}>a symbol</Rule>
          </ul>
        )}
      </div>

      {human.widget}

      <div className="grid grid-cols-2 gap-2">
        <Button id="auth-submit" type="submit" variant="primary" className={BUTTON} disabled={busy || !name || !password || unmet || !human.ready}>
          {signingUp ? 'make the account' : 'log in'}
        </Button>
        <Button
          id="auth-switch"
          className={BUTTON}
          onClick={() => {
            clearAuthError();
            onMode(signingUp ? 'login' : 'signup');
          }}
        >
          {signingUp ? 'have one? log in' : 'new here? sign up'}
        </Button>
      </div>

      {error && (
        <p id="auth-error" role="alert" className="text-base text-decrease">
          {error}
        </p>
      )}
      <OAuthButtons />
    </form>
  );
}

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
