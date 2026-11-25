import { useAtomValue } from 'jotai';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { usePeek } from '@/shared-components/peek';
import { PersonCard } from '@/shared-components/PersonCard';
import { ProfileLink } from '@/shared-components/ProfileLink';
import { cn } from '@/utils/cn';

const PEEK_MS = 300;
const COLUMN = '#chat, #friend-chat-thread';

export function Mention({ name, text }: { name: string; text: string }) {
  const me = useAtomValue(meAtom);
  const peek = usePeek(PEEK_MS);
  const self = !!me && me.toLowerCase() === name;
  const person = { name, verified: true, avatar: null };
  return (
    <span
      data-mention={name}
      data-mention-me={self || undefined}
      onPointerEnter={(e) => peek.show(e, e.currentTarget.closest(COLUMN))}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onFocus={(e) => peek.focus(e, e.currentTarget.closest(COLUMN))}
      onBlur={peek.blur}
      onKeyDown={peek.keyDown}
      className="relative [@media(hover:hover)]:group-hover/line:z-20"
    >
      <ProfileLink person={person} className={cn('font-medium text-primaryBlue underline-offset-2 hover:underline', self && 'rounded-control bg-primaryBlue/15 px-0.5')}>
        {text}
      </ProfileLink>
      {peek.at && <PersonCard id={`mention-peek-${name}`} person={person} at={peek.at} hold={peek.hold} />}
    </span>
  );
}
