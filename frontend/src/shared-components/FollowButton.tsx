import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { follow, followingNamesAtom, unfollow } from '@/infra/atoms/follow-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { Button } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

interface FollowButtonProps {
  id: string;
  name: string;
  /** The small size, for a row in a list. */
  small?: boolean;
  /** No shadow and no press, `Button`'s `flat`. */
  flat?: boolean;
  className?: string;
  /** Told after a follow or unfollow landed, with the new state. For a count beside the button. */
  onChange?: (following: boolean) => void;
}

/**
 * `follow`, or `following` for a name the login follows (`unfollow` while pointed at, so the
 * word says what the click does). For nobody it opens the security tab: an account is what a
 * follow hangs off. See docs/follows.md.
 */
export function FollowButton({ id, name, small, flat, className, onChange }: FollowButtonProps) {
  const me = useAtomValue(meAtom);
  const following = useAtomValue(followingNamesAtom).has(name);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const mine = me === name;

  async function toggle() {
    if (!me) {
      openUserModal('security');
      return;
    }
    if (busy) return;
    setBusy(true);
    const ok = following ? await unfollow(name) : await follow(name);
    setBusy(false);
    if (ok) onChange?.(!following);
  }

  if (mine) return null;
  const word = following ? (hover ? 'unfollow' : 'following') : 'follow';
  // dim while the request is out, but not `disabled`: chrome drops focus from a disabled button and
  // stops counting the pointer as over it, which reads as leaving the sidebar this button sits in
  return (
    <Button
      id={id}
      variant={following ? 'secondary' : 'primary'}
      flat={flat}
      aria-busy={busy}
      aria-pressed={following}
      data-following={following}
      title={me ? (following ? `stop following ${name}` : `follow ${name}`) : 'sign up or log in to follow people'}
      onClick={() => void toggle()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onBlur={() => setHover(false)}
      className={cn(
        small ? 'px-2.5 py-1 text-sm shadow-none' : 'px-3 py-1.5 text-sm',
        following && 'border-transparent bg-transparent text-primaryBlue shadow-none hover:border-transparent hover:bg-transparent',
        following && hover && 'text-decrease',
        busy && 'opacity-40',
        className
      )}
    >
      {word}
    </Button>
  );
}
