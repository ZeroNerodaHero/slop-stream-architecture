import { RiCloseLine, RiGlobalLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { showEmbedsAtom } from '@/infra/atoms/settings-atoms';
import { embedImageSrc, firstLink, type LinkEmbed as Embed } from '@/infra/link-embed';
import { embedOf } from '@/shared-components/ChatEmbeds';
import { ExternalLink, siteOf } from '@/shared-components/ExternalLink';
import { TALK_FROM } from '@/shared-components/LinkedText';
import { Tooltip } from '@/shared-components/Tooltip';

const HIDE_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textTertiary transition-colors duration-100 hover:border-primaryBlue hover:text-textPrimary focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue max-md:h-9 max-md:w-9';

function playsInline(text: string): boolean {
  const link = firstLink(text);
  return link !== null && embedOf(link) !== null;
}

const CARD = 'group/embed relative mt-1 block w-[360px] max-w-full overflow-hidden rounded-card border border-secondaryStroke bg-backgroundSecondary text-left';

const CHIP = 'flex min-w-0 items-center gap-1 rounded-control border border-primaryStroke bg-background px-1.5 py-0.5 text-[11px] leading-tight text-textSecondary';

const HIDE_SPOT =
  'absolute right-1.5 top-1.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/embed:opacity-100 [@media(hover:none)]:opacity-100';

export function LinkEmbed({ embed, text, onHide }: { embed: Embed | null | undefined; text: string; onHide?: () => void }) {
  const on = useAtomValue(showEmbedsAtom);
  const [broken, setBroken] = useState<string | null>(null);
  if (!on || !embed || playsInline(text)) return null;
  const { url, site, title, image } = embed;
  const picture = image && broken !== image.id ? image : null;
  if (!title && !picture) return null;
  const domain = siteOf(url);
  return (
    <span data-link-embed={domain} className={CARD}>
      <ExternalLink
        href={url}
        from={TALK_FROM}
        data-embed-link=""
        className="block text-left focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue"
      >
        {picture ? (
          <span data-embed-image={picture.id} className="relative block aspect-video w-full overflow-hidden bg-backgroundTertiary">
            <img
              src={embedImageSrc(picture)}
              alt=""
              width={picture.width}
              height={picture.height}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setBroken(picture.id)}
              className="absolute inset-0 h-full w-full object-cover"
            />
            {title && (
              <span className="absolute inset-x-0 bottom-0 flex min-h-12 items-end bg-gradient-to-t from-black/75 to-transparent p-2.5">
                <span data-embed-title="" className="line-clamp-2 text-[13px] font-semibold leading-snug text-white [overflow-wrap:anywhere]">
                  {title}
                </span>
              </span>
            )}
          </span>
        ) : (
          <span data-embed-title="" className="line-clamp-2 px-2.5 pt-2 text-[13px] font-semibold leading-snug text-textPrimary [overflow-wrap:anywhere]">
            {title}
          </span>
        )}
        <span className="flex items-center justify-between gap-2 px-2.5 py-2">
          <span data-embed-site="" className={CHIP}>
            <RiGlobalLine aria-hidden size={12} className="shrink-0" />
            <span className="truncate">{site || domain}</span>
          </span>
          <span data-embed-domain="" className="min-w-0 truncate text-[11px] leading-tight text-textTertiary">
            {domain}
          </span>
        </span>
      </ExternalLink>
      {onHide && (
        <span className={HIDE_SPOT}>
          <Tooltip content="hide embed">
            <button type="button" aria-label="hide embed" data-embed-hide="" onClick={onHide} className={HIDE_BUTTON}>
              <RiCloseLine aria-hidden size={14} />
            </button>
          </Tooltip>
        </span>
      )}
    </span>
  );
}
