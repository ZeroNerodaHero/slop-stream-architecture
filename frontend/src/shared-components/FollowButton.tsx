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
  /** The small size, for a row in a list. */
  small?: boolean;
  className?: string;
  /** Told after a follow or unfollow landed, with the new state. For a count beside the button. */
  onChange?: (following: boolean) => void;
}

/** The glyph and its word, one line. */
const LABEL = 'inline-flex items-center justify-center gap-1.5';

/**
 * `follow` with the add glyph in the blue fill, or, for a name the login follows, `following`
 * with the check glyph in the page's box, which turns to `unfollow` with the cross glyph, in red,
 * while pointed at, so the word says what the click does. The same box in every state: a
 * follow does not turn the button into bare words. A guest's follow is this browser's own
 * (follow-atoms.ts): kept here and told to nobody, so it is not one of the name's followers
 * and `onChange` is not told. See docs/follows.md.
 */
export function FollowButton({ id, name, small, className, onChange }: FollowButtonProps) {
  const me = useAtomValue(meAtom);
  const following = useAtomValue(followingNamesAtom).has(name);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const mine = me === name;

  async function toggle() {
    // before /api/me has answered nothing here is known, not who is asking nor what they follow: the click waits for the next one
    if (me === undefined || busy) return;
    setBusy(true);
    const ok = following ? await unfollow(name) : await follow(name);
    setBusy(false);
    if (!ok) return;
    // the pointer is still on the button: let it read `following` until it leaves and comes back,
    // rather than flip straight to a red `unfollow` under the click that followed
    setHover(false);
    // the count beside the button is the api's: only a login's follow reached it
    if (me) onChange?.(!following);
  }

  if (mine) return null;
  const size = small ? 14 : 16;
  const unfollowing = following && hover;
  // dim while the request is out, but not `disabled`: chrome drops focus from a disabled button and
  // stops counting the pointer as over it, which reads as leaving the sidebar this button sits in
  return (
    <Button
      id={id}
      variant={following ? 'secondary' : 'primary'}
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
      {following ? (
        // both words in one cell: the box keeps the wider one's width and does not wobble as they swap
        <span className="grid">
          <span className={cn(LABEL, 'col-start-1 row-start-1', hover && 'invisible')}>
            <RiUserFollowLine aria-hidden size={size} />
            following
          </span>
          <span className={cn(LABEL, 'col-start-1 row-start-1', !hover && 'invisible')}>
            <RiUserUnfollowLine aria-hidden size={size} />
            unfollow
          </span>
        </span>
      ) : (
        <span className={LABEL}>
          <RiUserAddLine aria-hidden size={size} />
          follow
        </span>
      )}
    </Button>
  );
}
