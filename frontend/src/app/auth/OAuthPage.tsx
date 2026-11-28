import { useAtomValue } from 'jotai';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { api, messageOf, type OAuthProvider } from '@/infra/api';
import { meAtom, reloadMe } from '@/infra/atoms/auth-atoms';
import { identityChanged } from '@/infra/atoms/profile-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { DESKTOP_TOKEN } from '@/infra/desktop/login';
import { cleanName, isValidName } from '@/infra/names';
import { providerLabel, takeReturn } from '@/infra/oauth';
import { Button, buttonClassName } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { useTurnstile } from '@/shared-components/Turnstile';
import { INPUT } from '@/shared-components/input';
import { BUTTON, Field, Status } from '@/shared-components/user-modal/parts';
import { HERE } from '@/infra/here';

const label = providerLabel;

function useGoBack() {
  const navigate = useNavigate();
  return useCallback(() => {
    const back = takeReturn();
    navigate(back.path, { replace: true });
    if (back.settings) openUserModal('security');
  }, [navigate]);
}

interface DesktopHandoff {
  code: string;
  state: string;
  next: 'done' | 'pick';
}

function readDesktop(hash: string): DesktopHandoff | 'bad' | null {
  const f = new URLSearchParams(hash.replace(/^#/, ''));
  if (!f.has('desktop')) return null;
  const code = f.get('desktop') ?? '';
  const state = f.get('state') ?? '';
  const next = f.get('next');
  if (!DESKTOP_TOKEN.test(code) || !DESKTOP_TOKEN.test(state) || (next !== 'done' && next !== 'pick')) return 'bad';
  return { code, state, next };
}

function BackToApp({ code, state, next }: DesktopHandoff) {
  const href = `nodentity://auth?code=${code}&state=${state}`;
  const opened = useRef(false);
  const open = useCallback(() => window.location.assign(href), [href]);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    open();
  }, [open]);

  return (
    <PageFrame title={next === 'pick' ? 'almost there' : 'signed in'}>
      <p id="oauth-desktop" className="text-textSecondary">
        {next === 'pick' ? 'return to the app to finish signing up' : 'signed in, return to the app'}
      </p>
      <p className="mt-4">
        <Button id="oauth-open-app" variant="primary" onClick={open}>
          open app
        </Button>
      </p>
    </PageFrame>
  );
}

export function OAuthPage() {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const me = useAtomValue(meAtom);
  const goBack = useGoBack();
  const desktop = readDesktop(hash);
  const error = desktop === 'bad' ? '' : params.get('error');
  const done = params.get('done');
  const linked = params.get('linked');
  const pick = params.get('pick');

  useEffect(() => {
    if (done === null && linked === null) return;
    void reloadMe().then(() => {
      identityChanged('login');
      goBack();
    });
  }, [done, linked, goBack]);

  if (error !== null) {
    return (
      <PageFrame title={me ? 'link' : 'log in'}>
        <p id="oauth-error" className="text-decrease">
          {error || 'that did not work. try again'}
        </p>
        <p className="mt-4">
          {me ? (
            <Button id="oauth-back" size="sm" onClick={goBack}>
              back to where you were
            </Button>
          ) : (
            <Link to="/login" className={buttonClassName('secondary', undefined, 'sm')}>
              back to log in
            </Link>
          )}
        </p>
      </PageFrame>
    );
  }
  if (desktop && desktop !== 'bad') return <BackToApp {...desktop} />;
  if (linked !== null) {
    return (
      <PageFrame title="linked">
        <p id="oauth-linked">you can log in with {label(linked)} now, and your name is verified. taking you back…</p>
      </PageFrame>
    );
  }
  if (pick !== null) return <PickName />;
  return (
    <PageFrame title="log in">
      <p className="text-textSecondary">logging you in…</p>
    </PageFrame>
  );
}

function PickName() {
  const me = useAtomValue(meAtom);
  const navigate = useNavigate();
  const [provider, setProvider] = useState<OAuthProvider | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const human = useTurnstile('oauth-turnstile');

  useEffect(() => {
    api
      .oauthSignupInfo()
      .then((r) => {
        setProvider(r.provider);
        setName(r.suggested);
      })
      .catch((err) => {
        setGone(true);
        setStatus(messageOf(err));
      });
  }, []);

  const wanted = cleanName(name);
  const ready = !busy && !gone && isValidName(wanted) && human.ready;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setStatus('');
    const token = human.token;
    human.spent();
    try {
      await api.oauthSignup(wanted, token);
      await reloadMe();
      identityChanged('login');
      const back = takeReturn();
      navigate(back.path, { replace: true });
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame title="pick your name">
      {me && <p className="mb-4 text-sm text-textTertiary">you are logged in as {me} in {HERE}; this makes a second account.</p>}
      <p className="mb-4 text-textSecondary">
        {provider ? `${label(provider)} is new here.` : ''} your name is yours alone: your page is /watch/&lt;name&gt;, and it can change once every 30 days.
      </p>
      <form onSubmit={(e) => void submit(e)} className="flex max-w-md flex-col gap-3">
        <Field id="oauth-name" label="name" hint="a-z 0-9 _ -, up to 32. a free name is yours, status, page and picture too.">
          <input
            id="oauth-name"
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
            disabled={gone}
            aria-describedby="oauth-name-hint"
            className={INPUT}
          />
        </Field>
        {!gone && human.widget}
        <div className="flex flex-wrap items-center gap-3">
          <Button id="oauth-submit" type="submit" variant="primary" className={BUTTON} disabled={!ready}>
            make the account
          </Button>
          {gone && (
            <Link to="/login" className={buttonClassName('secondary', undefined, 'sm')}>
              start again
            </Link>
          )}
        </div>
        <Status id="oauth-status" text={status} />
      </form>
    </PageFrame>
  );
}
