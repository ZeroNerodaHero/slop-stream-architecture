import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { api, messageOf, type OAuthProvider } from '@/infra/api';
import { meAtom, PROVIDER_LABEL, reloadMe } from '@/infra/atoms/auth-atoms';
import { identityChanged } from '@/infra/atoms/profile-atoms';
import { cleanName, isDummyName, isValidName } from '@/infra/names';
import { Button } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { BUTTON, Field, INPUT, Status } from '@/shared-components/user-modal/parts';

function label(p: string | null): string {
  return p && p in PROVIDER_LABEL ? PROVIDER_LABEL[p as OAuthProvider] : 'that account';
}

/**
 * Where the api sends the browser back after Google, Twitch or Discord (api/src/oauth.rs):
 * `?done=<p>` logged in, `?linked=<p>` attached to this account, `?pick=<p>` new here and
 * picking a name, `?error=<words>` it did not work. See docs/accounts.md.
 */
export function OAuthPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const error = params.get('error');
  const done = params.get('done');
  const linked = params.get('linked');
  const pick = params.get('pick');

  useEffect(() => {
    if (done === null && linked === null) return;
    // the login cookie is new (done) or the account gained a login (linked): who am i, again
    void reloadMe().then(() => {
      identityChanged('login');
      if (done !== null) navigate('/', { replace: true });
    });
  }, [done, linked, navigate]);

  if (error !== null) {
    return (
      <PageFrame title="log in">
        <p id="oauth-error" className="text-decrease">
          {error || 'that did not work. try again'}
        </p>
        <p className="mt-4">
          <Link to="/login" className="font-semibold text-primaryBlue">
            back to log in
          </Link>
        </p>
      </PageFrame>
    );
  }
  if (linked !== null) {
    return (
      <PageFrame title="linked">
        <p id="oauth-linked">you can log in with {label(linked)} now. the security tab lists your logins.</p>
        <p className="mt-4">
          <Link to="/" className="font-semibold text-primaryBlue">
            carry on
          </Link>
        </p>
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

/** New here through a provider: a name first, under the same rules as any signup. */
function PickName() {
  const me = useAtomValue(meAtom);
  const navigate = useNavigate();
  const [provider, setProvider] = useState<OAuthProvider | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

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
  const ready = !busy && !gone && isValidName(wanted) && !isDummyName(wanted);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setStatus('');
    try {
      await api.oauthSignup(wanted);
      await reloadMe();
      identityChanged('login');
      navigate('/', { replace: true });
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame title="pick your name">
      {me && <p className="mb-4 text-sm text-textTertiary">you are logged in as {me} in this browser; this makes a second account.</p>}
      <p className="mb-4 text-textSecondary">
        {provider ? `${label(provider)} is new here.` : ''} your name is yours alone: your page is /watch/&lt;name&gt;, and it can change once every 30 days.
      </p>
      <form onSubmit={(e) => void submit(e)} className="flex max-w-md flex-col gap-4">
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
            placeholder="a-z 0-9 _ -"
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
        <div className="flex flex-wrap items-center gap-3">
          <Button id="oauth-submit" type="submit" variant="primary" className={BUTTON} disabled={!ready}>
            make the account
          </Button>
          {gone && (
            <Link to="/login" className="text-sm font-semibold text-primaryBlue">
              start again
            </Link>
          )}
        </div>
        <Status id="oauth-status" text={status} />
      </form>
    </PageFrame>
  );
}
