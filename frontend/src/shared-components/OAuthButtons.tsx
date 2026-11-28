import { RiDiscordFill, RiGoogleFill, RiKickFill, RiLoginBoxLine, RiTwitchFill } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect } from 'react';

import type { OAuthProvider } from '@/infra/api';
import { loadOAuthProviders, oauthProvidersAtom, oauthStartUrl } from '@/infra/atoms/auth-atoms';
import { cancelDesktopLogin, desktopLoginAtom, startDesktopLogin } from '@/infra/desktop/login';
import { providerLabel, rememberReturn } from '@/infra/oauth';
import { inTauri } from '@/infra/update-check';
import { Button } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

export const PROVIDER_COLOR: Partial<Record<OAuthProvider, { brand: string; hover: string; text: string; on?: string }>> = {
  google: { brand: '#EA4335', hover: '#D33426', text: '#EA4335' },
  discord: { brand: '#5865F2', hover: '#4752C4', text: '#8891F2' },
  twitch: { brand: '#9146FF', hover: '#772CE8', text: '#A970FF' },
  kick: { brand: '#53FC18', hover: '#3FD10C', text: '#53FC18', on: '#0B0E0F' }
};

export function providerBrandStyle(provider: OAuthProvider): CSSProperties {
  const color = PROVIDER_COLOR[provider];
  return {
    '--brand': color?.brand ?? 'rgb(var(--primary-color))',
    '--brand-hover': color?.hover ?? 'rgb(var(--primary-color-hover))',
    '--brand-on': color?.on ?? '#fff'
  } as CSSProperties;
}

export function ProviderIcon({ provider, size = 18 }: { provider: OAuthProvider; size?: number }) {
  switch (provider) {
    case 'google':
      return <RiGoogleFill aria-hidden size={size} />;
    case 'discord':
      return <RiDiscordFill aria-hidden size={size} />;
    case 'twitch':
      return <RiTwitchFill aria-hidden size={size} />;
    case 'kick':
      return <RiKickFill aria-hidden size={size} />;
    default:
      return <RiLoginBoxLine aria-hidden size={size} />;
  }
}

const DESKTOP = inTauri();

function tileClass(branded: boolean) {
  return cn(
    'flex w-full min-w-0 items-center justify-center gap-2 rounded-control border border-primaryStroke px-3 py-2 text-base font-semibold focus-visible:outline-none',
    branded ? 'hover:border-[var(--brand)] focus-visible:border-[var(--brand)]' : 'text-textPrimary hover:border-primaryBlue focus-visible:border-primaryBlue'
  );
}

function TileFace({ provider }: { provider: OAuthProvider }) {
  const color = PROVIDER_COLOR[provider];
  return (
    <>
      <span className="flex shrink-0" style={color && { color: color.brand }}>
        <ProviderIcon provider={provider} />
      </span>
      <span className="truncate">{providerLabel(provider)}</span>
    </>
  );
}

function tileStyle(provider: OAuthProvider) {
  const color = PROVIDER_COLOR[provider];
  return color && ({ '--brand': color.brand, color: color.text } as CSSProperties);
}

function DesktopWait() {
  const { waiting, error } = useAtomValue(desktopLoginAtom);
  if (waiting === null && !error) return null;
  return (
    <div className="flex flex-wrap items-center gap-3" aria-live="polite">
      {waiting !== null && (
        <>
          <p id="oauth-desktop-wait" className="text-sm text-textSecondary">
            finish in your browser
          </p>
          <Button id="oauth-desktop-cancel" size="sm" onClick={cancelDesktopLogin}>
            cancel
          </Button>
        </>
      )}
      {error && (
        <p id="oauth-desktop-error" className="text-sm text-decrease">
          {error}
        </p>
      )}
    </div>
  );
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
        {providers.map((p) =>
          DESKTOP ? (
            <button key={p} id={`oauth-${p}`} type="button" onClick={() => void startDesktopLogin(p)} style={tileStyle(p)} className={tileClass(!!PROVIDER_COLOR[p])}>
              <TileFace provider={p} />
            </button>
          ) : (
            <a key={p} id={`oauth-${p}`} href={oauthStartUrl(p)} onClick={() => rememberReturn(false)} style={tileStyle(p)} className={tileClass(!!PROVIDER_COLOR[p])}>
              <TileFace provider={p} />
            </a>
          )
        )}
      </div>
      {DESKTOP && <DesktopWait />}
    </div>
  );
}
