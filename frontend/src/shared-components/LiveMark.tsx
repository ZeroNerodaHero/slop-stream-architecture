import { RiBroadcastLine } from '@remixicon/react';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/utils/cn';

export function LiveMark({ className, ...rest }: ComponentPropsWithoutRef<'span'>) {
  return (
    <span {...rest} className={cn('flex h-4 w-4 shrink-0 items-center justify-center bg-decrease text-background', className)}>
      <RiBroadcastLine aria-hidden size={10} />
    </span>
  );
}
