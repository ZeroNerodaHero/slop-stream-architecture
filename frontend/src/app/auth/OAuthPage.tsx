import { useAtomValue } from 'jotai';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { api, messageOf, type OAuthProvider } from '@/infra/api';
import { meAtom, reloadMe } from '@/infra/atoms/auth-atoms';
import { identityChanged } from '@/infra/atoms/profile-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { cleanName, isDummyName, isValidName } from '@/infra/names';
import { providerLabel, takeReturn } from '@/infra/oauth';
import { Button, buttonClassName } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { BUTTON, Field, INPUT, Status } from '@/shared-components/user-modal/parts';

const label = providerLabel;

/** Back where the trip to the provider started (infra/oauth.ts `rememberReturn`), the settings open on security when it started there. */
function useGoBack() {
  const navigate = useNavigate();
  return useCallback(() => {
    const back = takeReturn();
    navigate(back.path, { replace: true });
    if (back.settings) openUserModal('security');
  }, [navigate]);
}

/**
 * Where the api sends the browser back after Google or Discord (api/src/oauth.rs):
 * `?done=<p>` logged in, `?linked=<p>` attached to this account, `?pick=<p>` new here and
 * picking a name, `?error=<words>` it did not work. Logged in or linked, the page goes back to
 * where the trip started (a link from the security tab opens it again, showing the new login
 * and the verified mark). See docs/accounts.md.
 */
export function OAuthPage() {
  const [params] = useSearchParams();
  const me = useAtomValue(meAtom);
  const goBack = useGoBack();
  const error = params.get('error');
  const done = params.get('done');
  const linked = params.get('linked');
  const pick = params.get('pick');

  useEffect(() => {
    if (done === null && linked === null) return;
    // the login cookie is new (done) or the account gained a login (linked): who am i, again
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
