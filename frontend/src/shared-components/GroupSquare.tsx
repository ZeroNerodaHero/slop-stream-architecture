import { memo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { groupBanner, groupWords, type Server } from '@/infra/api';
import { GroupMark } from '@/shared-components/GroupMark';
import { cn } from '@/utils/cn';

export const GROUP_SQUARE_BOX = 'aspect-square border border-primaryStroke bg-backgroundSecondary';

export function GroupSquareFace({ server, corner, compact }: { server: Server; corner?: ReactNode; compact?: boolean }) {
  const banner = groupBanner(server.name, server.banner, 'square');
  const words = groupWords(server);
  return (
    <>
      <span
        className="absolute inset-0 transition-transform duration-300 ease-out group-hover:scale-105 group-focus-visible:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        style={{ backgroundColor: server.color }}
      >
        {banner && <img src={banner.src} srcSet={banner.srcSet} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />}
      </span>
      <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/10" />
      <GroupMark
        name={server.name}
        color={server.color}
        icon={server.icon}
        className={cn('absolute left-3 top-3 h-16 w-16 border-2 border-black/40 text-xl', compact && 'max-md:left-2 max-md:top-2 max-md:h-12 max-md:w-12')}
      />
      {corner}
      <span className={cn('relative px-3 py-2.5 text-white', compact && 'max-md:px-2 max-md:py-2')}>
        <span className="flex items-baseline gap-1 font-semibold">
          <span className="truncate">{words.title}</span>
          {words.tag && <span className="shrink-0 font-normal text-white/70">#{words.tag}</span>}
        </span>
        <span className="block truncate text-xs text-white/75">
          {server.public === false ? 'private · ' : ''}
          {server.members} {server.members === 1 ? 'member' : 'members'}
        </span>
      </span>
    </>
  );
}

export const GroupSquare = memo(function GroupSquare({ server, id }: { server: Server; id: string }) {
  const live = server.live?.length ?? 0;
  return (
    <li>
      <Link
        id={id}
        to={`/groups/${server.name}`}
        className={cn(
          GROUP_SQUARE_BOX,
          'group relative flex flex-col justify-end overflow-hidden transition-[border-color] duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue'
        )}
      >
        <GroupSquareFace
          server={server}
          corner={live > 0 && <span className="absolute right-2 top-2 bg-black/55 px-1.5 py-0.5 text-xs font-semibold text-increase">{live} live</span>}
        />
      </Link>
    </li>
  );
});
