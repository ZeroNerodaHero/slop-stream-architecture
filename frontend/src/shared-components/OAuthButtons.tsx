import { RiDiscordFill, RiGoogleFill, RiLoginBoxLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect } from 'react';

import type { OAuthProvider } from '@/infra/api';
import { loadOAuthProviders, oauthProvidersAtom, oauthStartUrl } from '@/infra/atoms/auth-atoms';
import { providerLabel, rememberReturn } from '@/infra/oauth';
import { cn } from '@/utils/cn';

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
      {/* one row: two columns edge to edge with the inputs (one column for a lone provider) */}
      <div className={cn('grid gap-2', providers.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
        {providers.map((p) => (
          <a
            key={p}
            id={`oauth-${p}`}
            href={oauthStartUrl(p)}
            onClick={() => rememberReturn(false)}
            className="flex w-full min-w-0 items-center justify-center gap-2 border border-primaryStroke px-3 py-2 text-base font-semibold text-textPrimary hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none"
          >
            <ProviderIcon provider={p} />
            <span className="truncate">
              {/* a narrow modal says the provider alone, beside its mark */}
              <span className="hidden min-[480px]:inline">continue with </span>
              {providerLabel(p)}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
