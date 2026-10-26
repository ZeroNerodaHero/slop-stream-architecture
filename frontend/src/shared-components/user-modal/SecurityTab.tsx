import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useState } from 'react';

import {
  authBusyAtom,
  authErrorAtom,
  changePassword,
  clearAuthError,
  clearPasswordStatus,
  login,
  logout,
  logoutAll,
  meAtom,
  passwordBusyAtom,
  passwordStatusAtom,
  signup
} from '@/infra/atoms/auth-atoms';
import { nickAtom } from '@/infra/atoms/chat-atoms';
import { identityChanged } from '@/infra/atoms/profile-atoms';
import { cleanName } from '@/infra/names';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { BUTTON, Field, INPUT, PasswordInput, Section, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/**
 * The account. Nobody has to have one; with one the name is yours. Logged out: log in or sign
 * up, right here (the /login and /signup pages are the same form with a place to go after).
 * Logged in: a new password, and the ways out. No email anywhere, so no reset: the words say so.
 */
export function SecurityTab() {
  const me = useAtomValue(meAtom);
  return <div className="divide-y divide-primaryStroke">{me ? <LoggedIn me={me} /> : <LoggedOut />}</div>;
}

function LoggedOut() {
  const busy = useAtomValue(authBusyAtom);
  const error = useAtomValue(authErrorAtom);
  const [signingUp, setSigningUp] = useState(false);
  // the nick, as the name it would be: signing up as it claims the bio and picture saved under it
  const [name, setName] = useState(() =>
    cleanName(store.get(nickAtom))
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32)
  );
  const [password, setPassword] = useState('');

  // Mount only: a stale error from the login page or an earlier open should not greet you here.
  useEffect(() => {
    clearAuthError();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await (signingUp ? signup(name, password) : login(name, password));
    if (ok) {
      setPassword('');
      identityChanged('login');
    }
  }

  return (
    <Section title="account" description="an account keeps your name yours: only you can go live, edit the bio or talk as it. nobody has to.">
      {/* no method="dialog": a submit would close the modal. onSubmit owns enter */}
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field id="sec-name" label="name" hint={signingUp ? 'a-z 0-9 _ -, up to 32. a free name is yours on sign up, bio and picture too.' : undefined}>
          <input
            id="sec-name"
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
            aria-describedby={signingUp ? 'sec-name-hint' : undefined}
            className={INPUT}
          />
        </Field>
        <Field id="sec-password" label="password" hint={signingUp ? '8 or more, anything goes. there is no reset: remember it.' : undefined}>
          <PasswordInput
            id="sec-password"
            value={password}
            onChange={setPassword}
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            minLength={signingUp ? 8 : undefined}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <Button id="sec-submit" type="submit" variant="primary" className={BUTTON} disabled={busy || !name || !password}>
            {signingUp ? 'sign up' : 'log in'}
          </Button>
          <button
            id="sec-mode"
            type="button"
            onClick={() => {
              setSigningUp((s) => !s);
              clearAuthError();
            }}
            className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline"
          >
            {signingUp ? 'have one? log in' : 'new here? sign up'}
          </button>
        </div>
        <Status id="sec-error" text={error} />
      </form>
    </Section>
  );
}

function LoggedIn({ me }: { me: string }) {
  const busy = useAtomValue(passwordBusyAtom);
  const status = useAtomValue(passwordStatusAtom);
  const [old, setOld] = useState('');
  const [fresh, setFresh] = useState('');
  const [sure, setSure] = useState(false);

  // Mount only: the last visit's "changed" should not still be there.
  useEffect(() => {
    clearPasswordStatus();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await changePassword(old, fresh)) {
      setOld('');
      setFresh('');
    }
  }

  return (
    <>
      <Section title="account">
        <p className="flex items-center gap-2 font-semibold">
          logged in as <span>{me}</span>
          <span className="text-increase" title="logged in: this name is yours">
            ✓
          </span>
        </p>
        <p className="text-sm text-textTertiary">a login lasts 30 days on each device.</p>
      </Section>

      <Section title="password" description="8 to 128 characters, anything goes. once it changes, every other login of this account is out; this one stays.">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          {/* for password managers: which account the new password belongs to */}
          <input type="text" name="username" value={me} autoComplete="username" readOnly tabIndex={-1} aria-hidden className="sr-only" />
          <Field id="sec-old" label="current password">
            <PasswordInput id="sec-old" value={old} onChange={setOld} autoComplete="current-password" />
          </Field>
          <Field id="sec-new" label="new password" hint="8 or more. there is no reset: remember it.">
            <PasswordInput id="sec-new" value={fresh} onChange={setFresh} autoComplete="new-password" minLength={8} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button id="sec-change" type="submit" className={BUTTON} disabled={busy || !old || fresh.length < 8}>
              change password
            </Button>
            <Status id="sec-status" text={status} />
          </div>
        </form>
      </Section>

      <Section title="sessions" description="this browser, or every browser this account is logged in on.">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            id="sec-logout"
            className={BUTTON}
            onClick={() => {
              void logout().then(() => identityChanged('login'));
            }}
          >
            log out
          </Button>
          {sure ? (
            <>
              <Button
                id="sec-logout-all"
                variant="danger"
                className={BUTTON}
                onClick={() => {
                  void logoutAll().then(() => identityChanged('login'));
                }}
              >
                sure? log out everywhere
              </Button>
              <button type="button" onClick={() => setSure(false)} className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline">
                keep
              </button>
            </>
          ) : (
            <Button id="sec-logout-all" className={cn(BUTTON, 'text-decrease hover:border-decrease')} onClick={() => setSure(true)}>
              log out everywhere
            </Button>
          )}
        </div>
        <p className="text-sm text-textTertiary">everywhere ends every login of this account on every device, this one too.</p>
      </Section>
    </>
  );
}
