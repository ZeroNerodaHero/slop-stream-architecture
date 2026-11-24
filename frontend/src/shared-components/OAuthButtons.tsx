import { RiDiscordFill, RiGoogleFill, RiLoginBoxLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect } from 'react';

import type { OAuthProvider } from '@/infra/api';
import { loadOAuthProviders, oauthProvidersAtom, oauthStartUrl } from '@/infra/atoms/auth-atoms';
import { providerLabel, rememberReturn } from '@/infra/oauth';
import { cn } from '@/utils/cn';

export const PROVIDER_COLOR: Partial<Record<OAuthProvider, { brand: string; hover: string; text: string }>> = {
  google: { brand: '#EA4335', hover: '#D33426', text: '#EA4335' },
  discord: { brand: '#5865F2', hover: '#4752C4', text: '#8891F2' }
};

export function providerBrandStyle(provider: OAuthProvider): CSSProperties {
  const color = PROVIDER_COLOR[provider];
  return {
    '--brand': color?.brand ?? 'rgb(var(--primary-color))',
    '--brand-hover': color?.hover ?? 'rgb(var(--primary-color-hover))'
  } as CSSProperties;
}

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

export function OAuthButtons() {
  const providers = useAtomValue(oauthProvidersAtom);

  useEffect(() => {
    void loadOAuthProviders();
  }, []);

  if (!providers?.length) return null;
  return (
    <div className="flex flex-col gap-2" aria-label="log in with another account">
      <p className="text-sm text-textTertiary">or continue with</p>
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
