import { useState } from 'react';

import { emoteSrc, type Emote as EmoteInfo } from '@/infra/emotes';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** An emote in a line: 1.375em, on the words' baseline. */
const INLINE = 'h-[1.375em] w-[1.375em] align-[-0.35em]';
/** A line of emotes alone: discord's jumbo. */
const JUMBO = 'h-[3em] w-[3em] align-bottom';

/**
 * One emote token drawn (docs/chat.md "emotes"): its picture, with `:name:` and its group in the
 * tooltip and `:name:` for a reader (and a copy). `info` is what the api said the id is: undefined
 * while it is being asked (the picture is drawn already, under the token's name), null for one
 * that is gone, which is the plain `:name:` it was written as. A picture that will not load is
 * that too.
 */
export function Emote({
  id,
  name,
  info,
  jumbo = false,
  className
}: {
  id: string;
  name: string;
  info: EmoteInfo | null | undefined;
  jumbo?: boolean;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const shown = info?.name ?? name;
  if (info === null || broken) return <>{`:${name}:`}</>;
  return (
    <Tooltip
      content={
        <span className="flex flex-col items-center">
          <span className="font-semibold">:{shown}:</span>
          {info && <span className="text-textTertiary">from {info.group}</span>}
        </span>
      }
    >
      <img
        src={emoteSrc(id)}
        alt={`:${shown}:`}
        data-emote={id}
        draggable={false}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={cn('inline-block object-contain', jumbo ? JUMBO : INLINE, className)}
      />
    </Tooltip>
  );
}
