import { groupImage } from '@/infra/api';
import { cn } from '@/utils/cn';

/**
 * The group's picture, or the first letter of its name on its colour. `name` is the address
 * (`gaming-0042`), which the picture's url is built from; its first letter is the title's.
 */
export function GroupMark({ id, name, color, icon, className }: { id?: string; name: string; color: string; icon?: number | null; className?: string }) {
  const src = groupImage(name, 'icon', icon);
  if (src) return <img id={id} src={src} alt="" className={cn('shrink-0 object-cover', className)} />;
  return (
    <span id={id} className={cn('flex shrink-0 items-center justify-center font-semibold uppercase text-white', className)} style={{ backgroundColor: color }}>
      {name.slice(0, 1)}
    </span>
  );
}
