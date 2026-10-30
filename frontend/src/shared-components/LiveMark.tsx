import { RiBroadcastLine } from '@remixicon/react';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/utils/cn';

/**
 * The red broadcast mark: a 16px box in `decrease` with the icon the inbox gives a go-live
 * (Notifications.tsx), drawn white on it. On the friends bar it sits on a streaming face's
 * corner (Friends.tsx); in the chat it stands beside the streamer's name (ChatPanel.tsx).
 * `className` places it; everything else (`title`, a label, a data attribute) goes on the box.
 */
export function LiveMark({ className, ...rest }: ComponentPropsWithoutRef<'span'>) {
  return (
    <span {...rest} className={cn('flex h-4 w-4 shrink-0 items-center justify-center bg-decrease text-background', className)}>
      <RiBroadcastLine aria-hidden size={10} />
    </span>
  );
}
