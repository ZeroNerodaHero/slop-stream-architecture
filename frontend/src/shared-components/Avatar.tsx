import { api } from '@/infra/api';
import { cn } from '@/utils/cn';

interface AvatarProps {
  name: string;
  /** The upload time from the api. `null` is no picture: nothing renders. */
  version: number | null | undefined;
  className?: string;
}

/**
 * A streamer's picture. The api serves the same <img> inside the watch page's
 * pre-react card (api/src/profile.rs, `AVATAR_IMG_CLASS`), so the two class
 * strings are kept the same there and here.
 */
export function Avatar({ name, version, className }: AvatarProps) {
  if (version === null || version === undefined) return null;
  return (
    <img src={api.avatarUrl(name, version)} alt="" className={cn('mr-3 inline-block h-10 w-10 border border-primaryStroke object-cover align-middle', className)} />
  );
}
