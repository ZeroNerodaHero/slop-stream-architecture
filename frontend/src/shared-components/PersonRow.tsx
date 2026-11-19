import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { type Presence, PRESENCE_SQUARE, PRESENCE_TEXT, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { isDummyName } from '@/infra/names';
import { Face } from '@/shared-components/Face';
import { OAuthMark } from '@/shared-components/OAuthMark';
import { TestBadge } from '@/shared-components/TestBadge';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** A name, its ✓ when it has an account, the verified mark when the account has a provider linked, the test badge for a fake stream. */
export function Who({ name, verified, oauthVerified, className }: { name: string; verified: boolean; oauthVerified?: boolean; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="truncate font-semibold">{name}</span>
      {verified && (
        <Tooltip content="has an account: this really is them">
          <span role="img" aria-label="has an account" className="shrink-0 text-increase">
            ✓
          </span>
        </Tooltip>
      )}
      {/* a free name never wears it, whatever a stale row says: only an account links a login */}
      {verified && oauthVerified && <OAuthMark />}
      {isDummyName(name) && <TestBadge />}
    </span>
  );
}

/**
 * The presence square on a face's bottom right corner, the colours of docs/status.md, ringed
 * in the background the face sits on: `className` names it (`border-backgroundSecondary` in the
 * chat window and on the card). The face's wrapper is `relative`. One 12px square for every
 * state, no icon: only the colour says which, so nothing beside it moves when a word changes.
 * `labelled`: the square says its word itself (an image named `online`, with the word's tooltip),
 * where nothing beside the face writes it out (the watch page's title row).
 */
export function PresenceSquare({ presence, className, id, labelled = false }: { presence: Presence; className?: string; id?: string; labelled?: boolean }) {
  const square = cn('absolute -bottom-1 -right-1 h-3 w-3 border-2', PRESENCE_SQUARE[presence], className);
  if (!labelled) return <span id={id} aria-hidden data-presence={presence} className={square} />;
  return (
    <Tooltip content={PRESENCE_WORD[presence]}>
      <span id={id} role="img" aria-label={PRESENCE_WORD[presence]} data-presence={presence} className={square} />
    </Tooltip>
  );
}

/** The square and the word, the colours of docs/status.md. `square={false}`: the word alone, where the face beside it already carries the square. */
export function Word({ presence, square = true, className }: { presence: Presence; square?: boolean; className?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-sm', PRESENCE_TEXT[presence], className)}>
      {square && <span aria-hidden className={cn('h-2.5 w-2.5', PRESENCE_SQUARE[presence])} />}
      {PRESENCE_WORD[presence]}
    </span>
  );
}

interface PersonRowProps {
  id: string;
  name: string;
  verified: boolean;
  /** The verified mark (a provider linked). Absent: not. */
  oauthVerified?: boolean;
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
 * Somebody, as a link to their watch page: the face with the presence square on its corner,
 * the name with its marks, the word beside it. One shape wherever a person is listed (the
 * search, home's people and recently offline).
 */
export function PersonRow({ id, name, verified, oauthVerified, avatar, bio, presence, onPick, size = 'row', note }: PersonRowProps) {
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
      {/* the square on the picture's corner, the sidebar's way, ringed in what the row sits on: the card's panel colour, else the page. the word says it in letters */}
      <span className="relative flex shrink-0">
        <Face name={name} version={avatar} className={card ? 'h-12 w-12 text-lg' : 'h-8 w-8 text-sm'} />
        <PresenceSquare presence={presence} className={card ? 'border-backgroundSecondary' : 'border-background'} />
      </span>
      {card ? (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Who name={name} verified={verified} oauthVerified={oauthVerified} className="text-base" />
          <Word presence={presence} square={false} />
          {note && <span className="text-sm text-textSecondary">{note}</span>}
          {/* the status is hover only: the row's title carries it, never a line here */}
        </span>
      ) : (
        <>
          <Who name={name} verified={verified} oauthVerified={oauthVerified} />
          <Word presence={presence} square={false} className="ml-auto" />
        </>
      )}
    </Link>
  );
}
