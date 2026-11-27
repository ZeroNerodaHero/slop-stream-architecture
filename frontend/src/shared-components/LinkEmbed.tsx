import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { showEmbedsAtom } from '@/infra/atoms/settings-atoms';
import { embedImageSrc, firstLink, type LinkEmbed as Embed } from '@/infra/link-embed';
import { embedOf } from '@/shared-components/ChatEmbeds';
import { ExternalLink, siteOf } from '@/shared-components/ExternalLink';
import { TALK_FROM } from '@/shared-components/LinkedText';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const HIDE_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textTertiary transition-colors duration-100 hover:border-primaryBlue hover:text-textPrimary focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue max-md:h-9 max-md:w-9';

function playsInline(text: string): boolean {
  const link = firstLink(text);
  return link !== null && embedOf(link) !== null;
}

export function LinkEmbed({ embed, text, onHide }: { embed: Embed | null | undefined; text: string; onHide?: () => void }) {
  const on = useAtomValue(showEmbedsAtom);
  const [broken, setBroken] = useState<string | null>(null);
  if (!on || !embed || (!embed.title && !embed.description) || playsInline(text)) return null;
  const { url, site, title, description, image, color } = embed;
  const picture = image && broken !== image.id ? image : null;
  return (
    <span
      data-link-embed={siteOf(url)}
      className={cn(
        'relative mt-1 flex w-[27rem] max-w-full items-start gap-2 overflow-hidden rounded-card border border-primaryStroke bg-backgroundSecondary px-3 py-2 text-left',
        '[[data-bubble]_&]:w-full [[data-bubble]_&]:rounded-none [[data-bubble]_&]:border-0 [[data-bubble]_&]:bg-transparent [[data-bubble]_&]:px-0 [[data-bubble]_&]:pb-1',
        color && 'border-l-2 [[data-bubble]_&]:border-l-2 [[data-bubble]_&]:pl-2'
      )}
      style={color ? { borderLeftColor: color } : undefined}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
        {site && (
          <span data-embed-site="" className="truncate text-xs text-textTertiary">
            {site}
          </span>
        )}
        {title && (
          <ExternalLink href={url} from={TALK_FROM} data-embed-title="" className="line-clamp-2 font-semibold text-primaryBlue underline-offset-2 [overflow-wrap:anywhere] hover:underline">
            {title}
          </ExternalLink>
        )}
        {description && (
          <span data-embed-description="" className="line-clamp-4 text-sm text-textSecondary [overflow-wrap:anywhere]">
            {description}
          </span>
        )}
        {picture && (
          <span
            data-embed-image={picture.id}
            className="relative mt-1 block max-h-80 w-full overflow-hidden rounded-card bg-backgroundTertiary"
            style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
          >
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
          </span>
        )}
      </span>
      {onHide && (
        <Tooltip content="hide embed">
          <button type="button" aria-label="hide embed" data-embed-hide="" onClick={onHide} className={HIDE_BUTTON}>
            <RiCloseLine aria-hidden size={14} />
          </button>
        </Tooltip>
      )}
    </span>
  );
}
