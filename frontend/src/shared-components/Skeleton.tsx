import type { ReactNode } from 'react';

import { cn } from '@/utils/cn';

/**
 * The grey a thing is before it has arrived: the tertiary background, breathing. Hard edges,
 * like every box here, and still under reduced motion. On a block, never on a border: a stroke
 * that fades reads as the box going, not as what is in it coming.
 */
export const BONE = 'animate-pulse bg-backgroundTertiary motion-reduce:animate-none';

/** One grey block the size and shape of what is coming: give it the height and the width. */
export function Bone({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block', BONE, className)} />;
}

interface SkeletonProps {
  /** For the tests: `#loading` on home, `#player-loading` on a stream's page. */
  id?: string;
  /** What is on its way, for screen readers. */
  label?: string;
  className?: string;
  children: ReactNode;
}

/**
 * What stands where a thing will stand while it is asked for: the same box, the same grid,
 * grey. So the page has its shape from the first paint and nothing moves when the answer
 * lands. Marked busy, and named, so a screen reader knows what the grey is.
 */
export function Skeleton({ id, label = 'loading', className, children }: SkeletonProps) {
  return (
    <div id={id} aria-busy="true" aria-label={label} className={className}>
      {children}
    </div>
  );
}
