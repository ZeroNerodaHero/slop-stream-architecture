import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/utils/cn';

export const BONE = 'animate-pulse bg-backgroundTertiary motion-reduce:animate-none';

export function Bone({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block', BONE, className)} />;
}

interface SkeletonProps {
  id?: string;
  label?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function Skeleton({ id, label = 'loading', className, style, children }: SkeletonProps) {
  return (
    <div id={id} aria-busy="true" aria-label={label} className={className} style={style}>
      {children}
    </div>
  );
}
