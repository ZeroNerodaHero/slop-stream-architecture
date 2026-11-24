import { RiBroadcastLine } from '@remixicon/react';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/utils/cn';

export function LiveMark({ size = 'sm', className, ...rest }: ComponentPropsWithoutRef<'span'> & { size?: 'xs' | 'sm' }) {
  return (
    <span {...rest} className={cn('flex shrink-0 items-center justify-center bg-decrease text-background', size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4', className)}>
      <RiBroadcastLine aria-hidden size={10} />
    </span>
  );
}
