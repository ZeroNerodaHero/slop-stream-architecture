import { RiDiscordFill, RiGoogleFill, RiLoginBoxLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect } from 'react';

import type { OAuthProvider } from '@/infra/api';
import { loadOAuthProviders, oauthProvidersAtom, oauthStartUrl } from '@/infra/atoms/auth-atoms';
import { providerLabel, rememberReturn } from '@/infra/oauth';
import { cn } from '@/utils/cn';

/**
 * A provider's brand colour: its mark and name, and its border on hover. Discord's name (only) is a lighter
 * blurple, since #5865F2 reads dim as text on the dark panel. Any other provider stays textPrimary.
 */
const PROVIDER_COLOR: Partial<Record<OAuthProvider, { brand: string; text: string }>> = {
  google: { brand: '#EA4335', text: '#EA4335' },
  discord: { brand: '#5865F2', text: '#8891F2' }
};

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
 * "or continue with" Google / Discord, under the log in and sign up forms. Only the providers the
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
      <p className="text-sm text-textTertiary">or continue with</p>
      {/* one row: two columns edge to edge with the inputs (one column for a lone provider) */}
      <div className={cn('grid gap-2', providers.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
        {providers.map((p) => {
          const color = PROVIDER_COLOR[p];
          return (
            <a
              key={p}
              id={`oauth-${p}`}
              href={oauthStartUrl(p)}
              onClick={() => rememberReturn(false)}
              style={color && ({ '--brand': color.brand, color: color.text } as CSSProperties)}
              className={cn(
                'flex w-full min-w-0 items-center justify-center gap-2 border border-primaryStroke px-3 py-2 text-base font-semibold focus-visible:outline-none',
                color ? 'hover:border-[var(--brand)] focus-visible:border-[var(--brand)]' : 'text-textPrimary hover:border-primaryBlue focus-visible:border-primaryBlue'
              )}
            >
              <span className="flex shrink-0" style={color && { color: color.brand }}>
                <ProviderIcon provider={p} />
              </span>
              <span className="truncate">{providerLabel(p)}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
