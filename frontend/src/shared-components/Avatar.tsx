import { api } from '@/infra/api';
import { cn } from '@/utils/cn';

interface AvatarProps {
  name: string;
  version: number | null | undefined;
  className?: string;
}

export function Avatar({ name, version, className }: AvatarProps) {
  if (version === null || version === undefined) return null;
  return (
    <img
      src={api.avatarUrl(name, version)}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      className={cn('mr-3 inline-block h-10 w-10 rounded-avatar border border-primaryStroke object-cover align-middle', className)}
    />
  );
}
