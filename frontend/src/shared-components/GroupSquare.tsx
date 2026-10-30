import { Link } from 'react-router-dom';

import { groupImage, groupWords, type Server } from '@/infra/api';
import { GroupMark } from '@/shared-components/GroupMark';

/** One group as a square: the banner or its colour, the picture, the name. */
export function GroupSquare({ server, id }: { server: Server; id: string }) {
  const banner = groupImage(server.name, 'banner', server.banner);
  const live = server.live?.length ?? 0;
  const words = groupWords(server);
  return (
    <li>
      <Link
        id={id}
        to={`/groups/${server.name}`}
        className="relative flex aspect-square flex-col justify-end overflow-hidden border border-primaryStroke bg-backgroundSecondary transition-[border-color] duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue"
      >
        <span className="absolute inset-0" style={{ backgroundColor: server.color }}>
          {banner && <img src={banner} alt="" className="h-full w-full object-cover" />}
        </span>
        <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/10" />
        <GroupMark name={server.name} color={server.color} icon={server.icon} className="absolute left-3 top-3 h-12 w-12 border-2 border-black/40 text-base" />
        {live > 0 && <span className="absolute right-2 top-2 bg-black/55 px-1.5 py-0.5 text-xs font-semibold text-increase">{live} live</span>}
        <span className="relative px-3 py-2.5 text-white">
          <span className="flex items-baseline gap-1 font-semibold">
            <span className="truncate">{words.title}</span>
            {words.tag && <span className="shrink-0 font-normal text-white/70">#{words.tag}</span>}
          </span>
          <span className="block truncate text-xs text-white/75">
            {server.public === false ? 'private · ' : ''}
            {server.members} {server.members === 1 ? 'member' : 'members'}
          </span>
        </span>
      </Link>
    </li>
  );
}
