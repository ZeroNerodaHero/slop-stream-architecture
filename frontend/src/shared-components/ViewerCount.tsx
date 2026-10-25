import { cn } from '@/utils/cn';

interface ViewerCountProps {
  /** `null`: nobody knows yet (not connected, or video did not answer). Renders nothing. */
  count: number | null;
  id?: string;
  className?: string;
}

/**
 * How many are watching: different addresses receiving the stream, counted by video (docs/viewers.md).
 * Five tabs on one wifi are one. `data-viewers` for the tests.
 */
export function ViewerCount({ count, id, className }: ViewerCountProps) {
  if (count === null) return null;
  return (
    <span id={id} data-viewers={count} title="different addresses receiving the stream right now" className={cn('tabular-nums', className)}>
      {count} watching
    </span>
  );
}
