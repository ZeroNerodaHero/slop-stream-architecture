import { cn } from '@/utils/cn';

interface ViewerCountProps {
  count: number | null;
  id?: string;
  className?: string;
}

export function ViewerCount({ count, id, className }: ViewerCountProps) {
  if (count === null) return null;
  return (
    <span id={id} data-viewers={count} title="different addresses receiving the stream right now" className={cn('tabular-nums', className)}>
      {count} watching
    </span>
  );
}
