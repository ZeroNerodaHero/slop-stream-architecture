import { Avatar } from '@/shared-components/Avatar';
import { GeneratedAvatar } from '@/shared-components/GeneratedAvatar';
import { cn } from '@/utils/cn';

interface FaceProps {
  name: string;
  version: number | null;
  className?: string;
}

export function Face({ name, version, className }: FaceProps) {
  if (version !== null) return <Avatar name={name} version={version} className={cn('mr-0 shrink-0', className)} />;
  return <GeneratedAvatar name={name} className={className} />;
}
