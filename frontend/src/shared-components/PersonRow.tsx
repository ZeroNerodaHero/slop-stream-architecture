import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { type Presence, PRESENCE_SQUARE, PRESENCE_TEXT, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { isDummyName } from '@/infra/names';
import { Face } from '@/shared-components/Face';
import { TestBadge } from '@/shared-components/TestBadge';
import { cn } from '@/utils/cn';

/** A name, its ✓ when it has an account, the test badge for a fake stream. */
export function Who({ name, verified, className }: { name: string; verified: boolean; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="truncate font-semibold">{name}</span>
      {verified && (
        <span className="shrink-0 text-increase" title="has an account: this really is them">
          ✓
        </span>
      )}
      {isDummyName(name) && <TestBadge />}
    </span>
  );
}

/**
 * The presence square on a face's bottom right corner, the colours of docs/status.md, ringed
 * in the background the face sits on: `className` names it (`border-backgroundSecondary` in the
 * chat window and on the card). The face's wrapper is `relative`.
 */
export function PresenceSquare({ presence, className }: { presence: Presence; className?: string }) {
  return <span aria-hidden data-presence={presence} className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2', PRESENCE_SQUARE[presence], className)} />;
}

/** The square and the word, the colours of docs/status.md. */
export function Word({ presence, className }: { presence: Presence; className?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-sm', PRESENCE_TEXT[presence], className)}>
      <span aria-hidden className={cn('h-2.5 w-2.5', PRESENCE_SQUARE[presence])} />
      {PRESENCE_WORD[presence]}
    </span>
  );
}

interface PersonRowProps {
  id: string;
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
  /** A click on the name: the list it is in closes. */
  onPick?: () => void;
  /** The small size, for a row in a dropdown; the large one is a card on home. */
  size?: 'row' | 'card';
  /** A line under the word, on the card only: home's recently offline say when the last stream ended. */
  note?: ReactNode;
}

/**
 * Somebody, as a link to their watch page: the face, the name with its marks, the word beside
 * it. One shape wherever a person is listed (the corner box, the search, home's people).
 */
export function PersonRow({ id, name, verified, avatar, bio, presence, onPick, size = 'row', note }: PersonRowProps) {
  const card = size === 'card';
  return (
    <Link
      id={id}
      to={`/watch/${encodeURIComponent(name)}`}
      // streaming: the page holds the player's box from its first paint (WatchPage.tsx)
      state={presence === 'streaming' ? { live: true } : undefined}
      onClick={onPick}
      title={bio || name}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2.5 border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue',
        card && 'gap-3'
      )}
    >
      <Face name={name} version={avatar} className={card ? 'h-12 w-12 text-lg' : 'h-8 w-8 text-sm'} />
      {card ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Who name={name} verified={verified} className="text-base" />
          <Word presence={presence} />
          {note && <span className="text-sm text-textSecondary">{note}</span>}
          {bio && <span className="truncate text-sm text-textSecondary">{bio}</span>}
        </span>
      ) : (
        <>
          <Who name={name} verified={verified} />
          <Word presence={presence} className="ml-auto" />
        </>
      )}
    </Link>
  );
}
