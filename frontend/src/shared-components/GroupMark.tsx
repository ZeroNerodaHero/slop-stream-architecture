import { groupImage } from '@/infra/api';
import { cn } from '@/utils/cn';

export function GroupMark({ id, name, color, icon, src, className }: { id?: string; name: string; color: string; icon?: number | null; src?: string | null; className?: string }) {
  const url = src ?? groupImage(name, 'icon', icon);
  if (url) return <img id={id} src={url} alt="" className={cn('shrink-0 object-cover', className)} />;
  return (
    <span id={id} className={cn('flex shrink-0 items-center justify-center font-semibold uppercase text-white', className)} style={{ backgroundColor: color }}>
      {name.slice(0, 1)}
    </span>
  );
}
