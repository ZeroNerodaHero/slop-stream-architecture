import { Avatar } from '@/shared-components/Avatar';
import { GeneratedAvatar } from '@/shared-components/GeneratedAvatar';
import { cn } from '@/utils/cn';

interface FaceProps {
  name: string;
  /** The picture's upload time (its `?v=`), or null for none: then the letter made from the name. */
  version: number | null;
  /** Size and the like; `h-10 w-10` by default, the text size for the letter goes with it. */
  className?: string;
}

/** Somebody's picture, or the letter their name makes when they have none. One shape wherever a face goes. */
export function Face({ name, version, className }: FaceProps) {
  if (version !== null) return <Avatar name={name} version={version} className={cn('mr-0 shrink-0', className)} />;
  return <GeneratedAvatar name={name} className={className} />;
}
