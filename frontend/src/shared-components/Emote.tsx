import { useState } from 'react';

import { emoteSrc, type Emote as EmoteInfo } from '@/infra/emotes';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const INLINE = 'h-[1.375em] w-[1.375em] align-[-0.35em]';
const JUMBO = 'h-[3em] w-[3em] align-bottom';

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
