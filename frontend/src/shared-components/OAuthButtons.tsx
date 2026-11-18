import { useAtomValue } from 'jotai';
import { useEffect } from 'react';

import { loadOAuthProviders, oauthProvidersAtom, oauthStartUrl, PROVIDER_LABEL } from '@/infra/atoms/auth-atoms';

/**
 * "continue with Google / Twitch / Discord", under the log in and sign up forms. Only the
 * providers the api turned on (their env vars are set); none, and this is nothing at all.
 * Plain links: the browser goes to the provider and comes back to /oauth (OAuthPage.tsx).
 * A provider login nobody here has asks for a name first; a known one logs straight in.
 */
export function OAuthButtons() {
  const providers = useAtomValue(oauthProvidersAtom);

  useEffect(() => {
    void loadOAuthProviders();
  }, []);

  if (!providers?.length) return null;
  return (
    <div className="flex flex-col gap-2" aria-label="log in with another account">
      <p className="text-sm text-textTertiary">or</p>
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => (
          <a
            key={p}
            id={`oauth-${p}`}
            href={oauthStartUrl(p)}
            className="border border-primaryStroke px-4 py-2 text-base font-semibold text-textPrimary hover:border-primaryBlue"
          >
            continue with {PROVIDER_LABEL[p]}
          </a>
        ))}
      </div>
    </div>
  );
}
