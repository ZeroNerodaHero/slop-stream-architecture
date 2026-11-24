import { RiUserAddLine, RiUserFollowLine, RiUserUnfollowLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { follow, followingNamesAtom, unfollow } from '@/infra/atoms/follow-atoms';
import { Button } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

interface FollowButtonProps {
  id: string;
  name: string;
  small?: boolean;
  className?: string;
  onChange?: (following: boolean) => void;
}

const LABEL = 'inline-flex items-center justify-center gap-1.5';

export function FollowButton({ id, name, small, className, onChange }: FollowButtonProps) {
  const me = useAtomValue(meAtom);
  const following = useAtomValue(followingNamesAtom).has(name);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const mine = me === name;

  async function toggle() {
    if (me === undefined || busy) return;
    setBusy(true);
    const ok = following ? await unfollow(name) : await follow(name);
    setBusy(false);
    if (!ok) return;
    setHover(false);
    if (me) onChange?.(!following);
  }

  if (mine) return null;
  const size = small ? 14 : 16;
  const unfollowing = following && hover;
  return (
    <Button
      id={id}
      variant={unfollowing ? 'secondary' : following ? 'success' : 'primary'}
      aria-busy={busy}
      aria-pressed={following}
      data-following={following}
      title={following ? `stop following ${name}` : `follow ${name}`}
      onClick={() => void toggle()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onBlur={() => setHover(false)}
      className={cn(
        small ? 'px-2.5 py-1 text-sm' : 'px-3 py-1.5 text-sm',
        unfollowing && 'border-decrease text-decrease hover:border-decrease',
        busy && 'opacity-40',
        className
      )}
    >
      <span className="grid">
        <span className={cn(LABEL, 'col-start-1 row-start-1', following && 'invisible')}>
          <RiUserAddLine aria-hidden size={size} />
          follow
        </span>
        <span className={cn(LABEL, 'col-start-1 row-start-1', (!following || hover) && 'invisible')}>
          <RiUserFollowLine aria-hidden size={size} />
          following
        </span>
        <span className={cn(LABEL, 'col-start-1 row-start-1', !unfollowing && 'invisible')}>
          <RiUserUnfollowLine aria-hidden size={size} />
          unfollow
        </span>
      </span>
    </Button>
  );
}
