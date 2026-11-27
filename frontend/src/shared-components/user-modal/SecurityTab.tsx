import { RiKickLine, RiLinkM, type RemixiconComponentType, RiTwitchLine, RiYoutubeLine } from '@remixicon/react';
import { useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useState } from 'react';

import { api, type DestinationPlatform, messageOf, type OAuthIdentities } from '@/infra/api';
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
import { DESTINATION_WORDS, DESTINATIONS_KEY, useDestinations } from '@/shared-components/live/modules/Destinations';
import { OAuthButtons, ProviderIcon, providerBrandStyle } from '@/shared-components/OAuthButtons';
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

      <StreamDestinations />

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

const PILL = 'flex min-w-0 items-stretch overflow-hidden rounded-control border border-primaryStroke bg-backgroundSecondary text-sm font-semibold max-md:min-h-11';
const SEGMENT = 'flex shrink-0 items-center whitespace-nowrap border-l border-primaryStroke px-3 transition-colors duration-100';
const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primaryBlue';

function LinkedPicture({ provider, src }: { provider: string; src?: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  const box = 'flex size-5 shrink-0 items-center justify-center rounded-avatar border border-primaryStroke bg-background';
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
                {on ? (
                  <span className={PILL}>
                    <span className="flex min-w-0 items-center gap-2 py-1.5 pl-1.5 pr-3 text-textPrimary">
                      <LinkedPicture provider={p} src={on.avatar} />
                      <Tooltip content={`since ${new Date(on.linked_at).toLocaleDateString()}`}>
                        <span id={`sec-linked-name-${p}`} tabIndex={0} className={`min-w-0 max-w-[180px] truncate ${FOCUS}`}>
                          {on.name || 'linked'}
                        </span>
                      </Tooltip>
                    </span>
                    {lastWayIn ? (
                      <Tooltip content="your only login">
                        <span id={`sec-unlink-${p}-why`} tabIndex={0} aria-label="unlink: your only login" className={`flex h-full shrink-0 ${FOCUS}`}>
                          <button type="button" disabled className={`pointer-events-none ${SEGMENT} text-textTertiary opacity-50`}>
                            unlink
                          </button>
                        </span>
                      </Tooltip>
                    ) : sure === p ? (
                      <>
                        <button
                          id={`sec-unlink-${p}`}
                          type="button"
                          disabled={busy}
                          className={`${SEGMENT} ${FOCUS} border-decrease bg-decrease text-white hover:opacity-90 disabled:opacity-50`}
                          onClick={() => void unlink(p)}
                        >
                          sure? unlink
                        </button>
                        <button type="button" className={`${SEGMENT} ${FOCUS} text-textSecondary hover:bg-backgroundTertiary hover:text-textPrimary`} onClick={() => setSure(null)}>
                          keep
                        </button>
                      </>
                    ) : (
                      <button id={`sec-unlink-${p}`} type="button" className={`${SEGMENT} ${FOCUS} text-textSecondary hover:bg-decrease/10 hover:text-decrease`} onClick={() => setSure(p)}>
                        unlink
                      </button>
                    )}
                  </span>
                ) : providers?.includes(p) ? (
                  <a
                    id={`sec-link-${p}`}
                    href={oauthStartUrl(p, true)}
                    onClick={() => rememberReturn(true)}
                    aria-label={`link ${providerLabel(p)}`}
                    style={providerBrandStyle(p)}
                    className={buttonClassName('primary', 'border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-on)] hover:border-[var(--brand-hover)] hover:bg-[var(--brand-hover)]', 'sm')}
                  >
                    link
                  </a>
                ) : null}
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

const DESTINATION_ICONS: Record<DestinationPlatform, RemixiconComponentType> = {
  twitch: RiTwitchLine,
  kick: RiKickLine,
  youtube: RiYoutubeLine,
  custom: RiLinkM
};

const DESTINATION_LABELS: Record<DestinationPlatform, string> = {
  twitch: 'Twitch',
  kick: 'Kick',
  youtube: 'YouTube',
  custom: DESTINATION_WORDS.custom
};

function StreamDestinations() {
  const { data } = useDestinations();
  const client = useQueryClient();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState<string | null>(null);
  if (!data?.destinations.length) return null;

  async function disconnect(id: string, name: string) {
    setBusy(true);
    setStatus('');
    try {
      await api.removeDestination(id);
      setStatus(`${name} disconnected: slop no longer holds its keys`);
      await client.invalidateQueries({ queryKey: DESTINATIONS_KEY });
    } catch (err) {
      setStatus(`not disconnected: ${messageOf(err)}`);
    } finally {
      setSure(null);
      setBusy(false);
    }
  }

  return (
    <Block id="sec-destinations" title="stream destinations" tip="the switch in the live rail pauses one; disconnect drops its keys">
      <ul className="flex flex-col">
        {data.destinations.map((d) => {
          const Icon = DESTINATION_ICONS[d.platform];
          const name = d.name || DESTINATION_WORDS[d.platform];
          return (
            <li key={d.id} id={`sec-destination-${d.platform}`} className="flex items-center justify-between gap-x-4 gap-y-1.5 py-1.5">
              <span className="flex shrink-0 items-center gap-2 text-sm font-semibold">
                <Icon aria-hidden size={16} />
                {DESTINATION_LABELS[d.platform]}
              </span>
              <span className={PILL}>
                <span className="flex min-w-0 items-center py-1.5 pl-3 pr-3 text-textPrimary">
                  <span className="min-w-0 max-w-[180px] truncate">{name}</span>
                </span>
                {sure === d.id ? (
                  <>
                    <button
                      id={`sec-disconnect-${d.platform}`}
                      type="button"
                      disabled={busy}
                      className={`${SEGMENT} ${FOCUS} border-decrease bg-decrease text-white hover:opacity-90 disabled:opacity-50`}
                      onClick={() => void disconnect(d.id, name)}
                    >
                      sure? disconnect
                    </button>
                    <button type="button" className={`${SEGMENT} ${FOCUS} text-textSecondary hover:bg-backgroundTertiary hover:text-textPrimary`} onClick={() => setSure(null)}>
                      keep
                    </button>
                  </>
                ) : (
                  <button
                    id={`sec-disconnect-${d.platform}`}
                    type="button"
                    className={`${SEGMENT} ${FOCUS} text-textSecondary hover:bg-decrease/10 hover:text-decrease`}
                    onClick={() => setSure(d.id)}
                  >
                    disconnect
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <Status id="sec-destinations-status" text={status} quiet />
    </Block>
  );
}
