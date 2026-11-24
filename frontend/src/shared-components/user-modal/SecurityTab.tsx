import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useState } from 'react';

import { api, messageOf, type OAuthIdentities } from '@/infra/api';
import {
  authBusyAtom,
  authErrorAtom,
  changePassword,
  clearAuthError,
  hasPasswordAtom,
  loadOAuthProviders,
  oauthProvidersAtom,
  oauthStartUrl,
  oauthVerifiedAtom,
  refreshMeInfo,
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
import { providerLabel, rememberReturn } from '@/infra/oauth';
import { NEW_PASSWORD_RULE, newPasswordProblem } from '@/infra/password';
import { store } from '@/infra/store';
import { Button, buttonClassName } from '@/shared-components/Button';
import { OAuthButtons, ProviderIcon } from '@/shared-components/OAuthButtons';
import { OAUTH_MARK_WORDS, OAuthMark } from '@/shared-components/OAuthMark';
import { Tooltip } from '@/shared-components/Tooltip';
import { useTurnstile } from '@/shared-components/Turnstile';
import { INPUT } from '@/shared-components/input';
import { BUTTON, Block, Field, PasswordInput, Status } from '@/shared-components/user-modal/parts';

export function SecurityTab() {
  const me = useAtomValue(meAtom);
  return <div className="divide-y divide-primaryStroke">{me ? <LoggedIn me={me} /> : <LoggedOut />}</div>;
}

function LoggedOut() {
  const busy = useAtomValue(authBusyAtom);
  const error = useAtomValue(authErrorAtom);
  const [signingUp, setSigningUp] = useState(false);
  const [name, setName] = useState(() =>
    cleanName(store.get(nickAtom))
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32)
  );
  const [password, setPassword] = useState('');
  const problem = signingUp && password ? newPasswordProblem(password) : null;
  const human = useTurnstile('sec-turnstile');

  useEffect(() => {
    clearAuthError();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem || !human.ready) return;
    const ok = await (signingUp ? signup(name, password, human.token) : login(name, password, human.token));
    human.spent();
    if (ok) {
      setPassword('');
      identityChanged('login');
    }
  }

  return (
    <Block title="account">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Field id="sec-name" label="name" hint="a-z 0-9 _ -">
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
            placeholder="username"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={32}
            required
            aria-describedby="sec-name-hint"
            className={INPUT}
          />
        </Field>
        <Field id="sec-password" label="password" hint={signingUp ? <PasswordHint problem={problem} /> : undefined}>
          <PasswordInput
            id="sec-password"
            value={password}
            onChange={setPassword}
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            minLength={signingUp ? 8 : undefined}
          />
        </Field>
        {human.widget}
        <div className="grid grid-cols-2 gap-2">
          <Button id="sec-submit" type="submit" variant="primary" className={BUTTON} disabled={busy || !name || !password || !!problem || !human.ready}>
            {signingUp ? 'sign up' : 'log in'}
          </Button>
          <Button
            id="sec-mode"
            className={BUTTON}
            onClick={() => {
              setSigningUp((s) => !s);
              clearAuthError();
            }}
          >
            {signingUp ? 'have one? log in' : 'new here? sign up'}
          </Button>
        </div>
        <Status id="sec-error" text={error} />
        <OAuthButtons />
      </form>
    </Block>
  );
}

function LoggedIn({ me }: { me: string }) {
  const hasPassword = useAtomValue(hasPasswordAtom);
  const oauthVerified = useAtomValue(oauthVerifiedAtom);
  const busy = useAtomValue(passwordBusyAtom);
  const status = useAtomValue(passwordStatusAtom);
  const [old, setOld] = useState('');
  const [fresh, setFresh] = useState('');
  const [sure, setSure] = useState(false);
  const problem = fresh ? newPasswordProblem(fresh) : null;

  useEffect(() => {
    clearPasswordStatus();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    if (await changePassword(hasPassword ? old : '', fresh)) {
      setOld('');
      setFresh('');
    }
  }

  return (
    <>
      <Block title="account" tip="a login lasts 30 days on each device">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <span>{me}</span>
          <Tooltip content="logged in: this name is yours">
            <span role="img" aria-label="logged in" className="text-increase">
              ✓
            </span>
          </Tooltip>
          {oauthVerified && <OAuthMark id="sec-oauth-verified" size={14} />}
        </p>
      </Block>

      <Block title="password">
        <form onSubmit={(e) => void submit(e)}>
          <input type="text" name="username" value={me} autoComplete="username" readOnly tabIndex={-1} aria-hidden className="sr-only" />
          <div className="flex flex-wrap gap-1.5">
            {hasPassword && (
              <PasswordInput
                id="sec-old"
                value={old}
                onChange={setOld}
                autoComplete="current-password"
                placeholder="current"
                label="current password"
                className="min-w-0 flex-1 basis-40"
              />
            )}
            <PasswordInput
              id="sec-new"
              value={fresh}
              onChange={setFresh}
              autoComplete="new-password"
              minLength={8}
              placeholder="new"
              label="new password"
              describedBy="sec-new-hint"
              className="min-w-0 flex-1 basis-40"
            />
            <Button id="sec-change" type="submit" size="sm" variant="outline" disabled={busy || (hasPassword && !old) || !fresh || !!problem}>
              {hasPassword ? 'change' : 'set'}
            </Button>
          </div>
          <p id="sec-new-hint" className="mt-1 text-xs text-textTertiary">
            {problem ? <span className="text-decrease">{problem}</span> : `${hasPassword ? '' : 'no password yet · '}8–128 · a number and a symbol · no reset`}
          </p>
          <Status id="sec-status" text={status} quiet />
        </form>
      </Block>

      <LinkedLogins />

      <Block title="sessions">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            id="sec-logout"
            size="sm"
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
                size="sm"
                variant="danger"
                onClick={() => {
                  void logoutAll().then(() => identityChanged('login'));
                }}
              >
                sure? every device
              </Button>
              <Button size="sm" onClick={() => setSure(false)}>
                keep
              </Button>
            </>
          ) : (
            <Button id="sec-logout-all" size="sm" variant="outline-danger" onClick={() => setSure(true)}>
              log out all
            </Button>
          )}
        </div>
      </Block>
    </>
  );
}

function PasswordHint({ problem }: { problem: string | null }) {
  return problem ? <span className="text-decrease">{problem}</span> : <>{NEW_PASSWORD_RULE}. there is no reset: remember it.</>;
}

function LinkedPicture({ provider, src }: { provider: string; src?: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  const box = 'flex size-6 shrink-0 items-center justify-center border border-primaryStroke';
  if (!src || broken === src) {
    return (
      <span className={box}>
        <ProviderIcon provider={provider} size={14} />
      </span>
    );
  }
  return <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(src)} className={`${box} object-cover`} />;
}

function LinkedLogins() {
  const providers = useAtomValue(oauthProvidersAtom);
  const [linked, setLinked] = useState<OAuthIdentities | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState<string | null>(null);

  useEffect(() => {
    void loadOAuthProviders();
    api
      .oauthIdentities()
      .then(setLinked)
      .catch((err) => {
        setLinked(null);
        setStatus(`could not read your linked logins: ${messageOf(err)}`);
      });
  }, []);

  const mine = linked?.identities.map((i) => i.provider) ?? [];
  const shown = [...new Set([...(providers ?? []), ...mine])];
  if (!shown.length) return null;
  const lastWayIn = !!linked && !linked.has_password && mine.length <= 1;
  const verified = linked ? (linked.oauth_verified ?? mine.length > 0) : false;

  async function unlink(p: string) {
    setBusy(true);
    setStatus('');
    try {
      await api.oauthUnlink(p);
      setLinked(await api.oauthIdentities());
      setStatus(`${providerLabel(p)} unlinked`);
    } catch (err) {
      setStatus(`not unlinked: ${messageOf(err)}`);
    } finally {
      setSure(null);
      setBusy(false);
      void refreshMeInfo();
    }
  }

  return (
    <Block id="sec-linked" title="linked logins" tip="verified: the blue mark by your name">
      <div className="relative">
        <ul id="sec-verified" data-verified={verified} className="flex flex-col">
          {shown.map((p) => {
            const on = linked?.identities.find((i) => i.provider === p);
            return (
              <li
                key={p}
                id={`sec-provider-${p}`}
                data-linked={on ? 'true' : 'false'}
                className={`flex items-center justify-between gap-x-4 gap-y-1.5 py-1.5 ${on ? '' : 'flex-wrap'}`}
              >
                <span className="flex shrink-0 items-center gap-2 text-sm font-semibold">
                  <ProviderIcon provider={p} />
                  {providerLabel(p)}
                </span>
                <span className={on ? 'flex min-w-0 items-center gap-2 border border-primaryStroke p-1' : 'flex flex-wrap items-center gap-1.5'}>
                  {on ? (
                    <>
                      <LinkedPicture provider={p} src={on.avatar} />
                      <Tooltip content={`since ${new Date(on.linked_at).toLocaleDateString()}`}>
                        <span id={`sec-linked-name-${p}`} tabIndex={0} className="min-w-0 max-w-[180px] truncate text-sm font-semibold">
                          {on.name || 'linked'}
                        </span>
                      </Tooltip>
                      {lastWayIn ? (
                        <Tooltip content="your only login">
                          <span id={`sec-unlink-${p}-why`} tabIndex={0} aria-label="unlink: your only login" className="inline-flex shrink-0">
                            <Button size="sm" variant="outline-danger" disabled className="pointer-events-none shrink-0">
                              unlink
                            </Button>
                          </span>
                        </Tooltip>
                      ) : sure === p ? (
                        <>
                          <Button
                            id={`sec-unlink-${p}`}
                            size="sm"
                            variant="outline-danger"
                            disabled={busy}
                            className="shrink-0 whitespace-nowrap"
                            onClick={() => void unlink(p)}
                          >
                            sure? unlink
                          </Button>
                          <Button size="sm" className="shrink-0" onClick={() => setSure(null)}>
                            keep
                          </Button>
                        </>
                      ) : (
                        <Button id={`sec-unlink-${p}`} size="sm" variant="outline-danger" className="shrink-0" onClick={() => setSure(p)}>
                          unlink
                        </Button>
                      )}
                    </>
                  ) : providers?.includes(p) ? (
                    <a
                      id={`sec-link-${p}`}
                      href={oauthStartUrl(p, true)}
                      onClick={() => rememberReturn(true)}
                      aria-label={`link ${providerLabel(p)}`}
                      className={buttonClassName('outline', undefined, 'sm')}
                    >
                      link
                    </a>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="sr-only">{OAUTH_MARK_WORDS}</p>
      </div>
      <Status id="sec-linked-status" text={status} quiet />
    </Block>
  );
}
