import {
  RiBlueskyFill,
  RiDiscordFill,
  RiFacebookFill,
  RiGithubFill,
  RiGlobalLine,
  RiInstagramFill,
  RiKickFill,
  RiPatreonFill,
  RiRedditFill,
  RiSnapchatFill,
  RiSoundcloudFill,
  RiSpotifyFill,
  RiSteamFill,
  RiTelegramFill,
  RiThreadsFill,
  RiTiktokFill,
  RiTwitchFill,
  RiTwitterXFill,
  RiYoutubeFill
} from '@remixicon/react';

import { hostOf, type SocialKind, type Socials as SocialsDoc, type SocialsSize } from '@/infra/socials';
import { buttonClassName } from '@/shared-components/Button';
import { ExternalLink } from '@/shared-components/ExternalLink';
import { cn } from '@/utils/cn';

export const SOCIAL_ICON: Record<SocialKind, typeof RiGlobalLine> = {
  tiktok: RiTiktokFill,
  youtube: RiYoutubeFill,
  twitch: RiTwitchFill,
  kick: RiKickFill,
  discord: RiDiscordFill,
  instagram: RiInstagramFill,
  x: RiTwitterXFill,
  threads: RiThreadsFill,
  bluesky: RiBlueskyFill,
  facebook: RiFacebookFill,
  snapchat: RiSnapchatFill,
  reddit: RiRedditFill,
  github: RiGithubFill,
  spotify: RiSpotifyFill,
  soundcloud: RiSoundcloudFill,
  patreon: RiPatreonFill,
  telegram: RiTelegramFill,
  steam: RiSteamFill,
  web: RiGlobalLine
};

export const SOCIAL_ICON_PX: Record<SocialsSize, number> = { small: 16, medium: 28, large: 40 };
const CHIP: Record<SocialsSize, string> = {
  small: 'gap-1.5 px-2 py-1 text-sm',
  medium: 'gap-2.5 px-3 py-2 text-base',
  large: 'gap-3 px-4 py-3 text-lg'
};
const GRID: Record<SocialsSize, string> = {
  small: 'grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2',
  medium: 'grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3',
  large: 'grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4'
};
const CARD: Record<SocialsSize, string> = {
  small: 'gap-1.5 p-3 text-sm',
  medium: 'gap-2.5 p-4 text-base',
  large: 'gap-3 p-6 text-lg'
};
const LINK =
  'rounded-control border border-primaryStroke bg-backgroundSecondary text-textPrimary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none';

interface SocialsProps {
  name: string;
  doc: SocialsDoc;
  onEdit?: () => void;
  id?: string;
  className?: string;
}

export function Socials({ name, doc, onEdit, id = 'socials', className }: SocialsProps) {
  const px = SOCIAL_ICON_PX[doc.size];
  if (doc.links.length === 0) {
    return (
      <div id={id} data-layout={doc.layout} data-size={doc.size} data-empty className={cn('flex flex-wrap items-center gap-3 text-textSecondary', className)}>
        <p>{onEdit ? 'nowhere else yet. put your links here: where you post, where to find you between streams.' : `${name} has not put any links here yet.`}</p>
        {onEdit && (
          <button id="socials-edit" type="button" onClick={onEdit} className={buttonClassName('primary', 'px-3 py-1.5 text-sm')}>
            add links
          </button>
        )}
      </div>
    );
  }
  return (
    <div id={id} data-layout={doc.layout} data-size={doc.size} className={cn('min-w-0', className)}>
      <ul className={cn('m-0 list-none p-0', doc.layout === 'row' ? 'flex flex-wrap gap-2' : cn('grid', GRID[doc.size]))}>
        {doc.links.map((link, i) => {
          const Icon = SOCIAL_ICON[link.kind];
          const word = link.label || link.kind;
          const host = hostOf(link.url);
          return (
            <li key={`${link.url}-${i}`} className="min-w-0">
              <ExternalLink
                href={link.url}
                from={`${name} put this link here, not this site.`}
                data-kind={link.kind}
                title={`${word} · ${host}`}
                aria-label={`${word}, ${host}, opens in a new tab`}
                className={cn(
                  LINK,
                  doc.layout === 'row'
                    ? cn('inline-flex max-w-full items-center', CHIP[doc.size])
                    : cn('flex h-full flex-col items-center justify-center text-center', CARD[doc.size])
                )}
              >
                <Icon aria-hidden size={px} className="shrink-0" />
                <span className="min-w-0 truncate font-semibold leading-tight">{word}</span>
                {doc.layout === 'grid' && <span className="min-w-0 max-w-full truncate text-xs text-textTertiary">{host}</span>}
              </ExternalLink>
            </li>
          );
        })}
      </ul>
      {onEdit && (
        <p className="mt-3 text-sm text-textTertiary">
          yours.{' '}
          <button id="socials-edit" type="button" onClick={onEdit} className="text-primaryBlue underline-offset-2 hover:underline">
            edit the links
          </button>
        </p>
      )}
    </div>
  );
}
