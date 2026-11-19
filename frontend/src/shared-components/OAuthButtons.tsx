import { RiDiscordFill, RiGoogleFill, RiLoginBoxLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect } from 'react';

import type { OAuthProvider } from '@/infra/api';
import { loadOAuthProviders, oauthProvidersAtom, oauthStartUrl } from '@/infra/atoms/auth-atoms';
import { providerLabel, rememberReturn } from '@/infra/oauth';

/** The provider's mark, or a plain one for a provider this build has no icon for (infra/oauth.ts). */
export function ProviderIcon({ provider, size = 18 }: { provider: OAuthProvider; size?: number }) {
  switch (provider) {
    case 'google':
      return <RiGoogleFill aria-hidden size={size} />;
    case 'discord':
      return <RiDiscordFill aria-hidden size={size} />;
    default:
      return <RiLoginBoxLine aria-hidden size={size} />;
  }
}

/**
 * "continue with Google / Discord", under the log in and sign up forms. Only the providers the
 * api turned on (their env vars are set); none, and this is nothing at all. Plain links: the
 * browser goes to the provider and comes back to /oauth (OAuthPage.tsx), then to the page it
 * left. A provider login nobody here has asks for a name first; a known one logs straight in.
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
            onClick={() => rememberReturn(false)}
            className="flex items-center gap-2 border border-primaryStroke px-4 py-2 text-base font-semibold text-textPrimary hover:border-primaryBlue"
          >
            <ProviderIcon provider={p} />
            continue with {providerLabel(p)}
          </a>
        ))}
      </div>
    </div>
  );
}
