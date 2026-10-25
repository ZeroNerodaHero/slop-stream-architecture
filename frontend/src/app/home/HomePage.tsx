import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, messageOf, type LiveStream } from '@/infra/api';
import { isDummyName } from '@/infra/names';
import { Avatar } from '@/shared-components/Avatar';
import { buttonClassName } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { TestBadge } from '@/shared-components/TestBadge';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { cn } from '@/utils/cn';
import { since } from '@/utils/since';

const POLL_MS = 3000;
/** Thumbnails change every 5s on the publisher side; re-fetch on that rhythm. */
const THUMB_BUCKET_MS = 5000;

/** One card per column, as many columns as fit: 1 on a phone, 2 on a tablet, 4 at full width. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6';
/**
 * A card is the panel look without its offset shadow: in a grid, the offsets read as a second
 * box behind every stream. The stroke goes blue on hover and keyboard focus instead.
 */
const CARD = 'border border-primaryStroke bg-backgroundSecondary';
const CARD_LINK = cn(CARD, 'group transition-[border-color] duration-150 hover:border-primaryBlue focus-within:border-primaryBlue');

/**
 * The picture on the card. The streamer's own, taking turns every bucket, when they have
 * put some. Otherwise the camera, a few seconds old. A 404 (the first camera frame takes
 * ~6s, home lists the stream within 3s) only hides the img: the next bucket is a new src
 * on the same element, which loads again and shows it. Unmounting it would end that.
 */
function Thumb({ name, bucket, thumbs }: { name: string; bucket: number; thumbs: number[] }) {
  const [missing, setMissing] = useState(false);
  const custom = thumbs.length > 0 ? thumbs[bucket % thumbs.length] : undefined;
  const src = custom !== undefined ? api.streamThumbUrl(name, custom) : api.thumbUrl(name, bucket);
  return (
    <img
      src={src}
      alt=""
      data-thumb={name}
      className={cn('absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105', missing && 'opacity-0')}
      onError={() => setMissing(true)}
      onLoad={() => setMissing(false)}
    />
  );
}

/** The streamer's picture, or their first letter when they have none, so every card lines up the same. */
function Face({ stream }: { stream: LiveStream }) {
  if (stream.avatar !== null) return <Avatar name={stream.name} version={stream.avatar} className="mr-0 h-11 w-11 shrink-0" />;
  return (
    <span
      aria-hidden
      className="flex h-11 w-11 shrink-0 items-center justify-center border border-primaryStroke bg-backgroundTertiary text-lg font-semibold uppercase text-textSecondary"
    >
      {stream.name[0]}
    </span>
  );
}

function Card({ stream, now, bucket }: { stream: LiveStream; now: number; bucket: number }) {
  const age = since(stream.since, now);
  return (
    <article className={CARD_LINK}>
      <Link to={`/watch/${encodeURIComponent(stream.name)}`} aria-label={`watch ${stream.name}`} className="block outline-none">
        {/* one chip, top right: "live for 52 hr". the fake streams draw their name top-left and a clock bottom-left */}
        <div className="relative aspect-video overflow-hidden border-b border-primaryStroke bg-black">
          <Thumb name={stream.name} bucket={bucket} thumbs={stream.thumbs ?? []} />
          <span className="absolute right-3 top-3 flex items-center gap-1.5 border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
            <span aria-hidden className="h-2 w-2 animate-pulse bg-increase" />
            {age || 'live'}
          </span>
          {stream.viewers !== null && (
            <span className="absolute bottom-3 right-3 border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold text-white backdrop-blur-sm">
              <ViewerCount count={stream.viewers} />
            </span>
          )}
        </div>
        <div className="flex items-start gap-3 p-4">
          <Face stream={stream} />
          <div className="min-w-0 flex-1">
            <h2 className="flex min-w-0 items-center text-xl font-semibold leading-tight">
              <span className="truncate">{stream.name}</span>
              {stream.verified && (
                <span className="ml-1.5 shrink-0 text-increase" title="has an account: this really is them">
                  ✓
                </span>
              )}
              {isDummyName(stream.name) && (
                <span className="shrink-0">
                  <TestBadge />
                </span>
              )}
            </h2>
            {stream.bio && <p className="mt-1 line-clamp-2 text-base leading-snug text-textSecondary [overflow-wrap:anywhere]">{stream.bio}</p>}
          </div>
        </div>
      </Link>
    </article>
  );
}

/** Three cards' worth of grey, for the moment before the first answer. */
function Skeleton() {
  return (
    <div id="loading" className={GRID} aria-busy="true" aria-label="loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className={cn(CARD, 'animate-pulse')}>
          <div className="aspect-video border-b border-primaryStroke bg-backgroundTertiary" />
          <div className="flex items-start gap-3 p-4">
            <span className="h-11 w-11 shrink-0 bg-backgroundTertiary" />
            <div className="flex-1 space-y-2 py-1">
              <div className="h-4 w-1/2 bg-backgroundTertiary" />
              <div className="h-3 w-5/6 bg-backgroundTertiary" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomePage() {
  // the poll is also the page's clock: `since` and the thumbnail bucket move with each answer (every
  // 3s), so the render never reads the time itself. no retries on focus, the poll is the schedule.
  const streams = useQuery({ queryKey: ['streams'], queryFn: api.streams, refetchInterval: POLL_MS, refetchOnWindowFocus: false });
  const now = streams.dataUpdatedAt;
  const bucket = Math.floor(now / THUMB_BUCKET_MS);
  // under an error the last good list is stale: the line says why there is none
  const list = streams.error ? undefined : streams.data;

  // no title row: the cards are the page. "go live" is in the corner panel (UserPanel), and once more in the empty state.
  return (
    <PageFrame wide>
      {streams.error && (
        <p className="border border-decrease/40 bg-decrease/10 px-5 py-4 text-textSecondary" aria-live="polite">
          api is down: {messageOf(streams.error)}
        </p>
      )}
      {!streams.error && !streams.data && <Skeleton />}
      {list?.length === 0 && (
        <div id="empty" className="border border-dashed border-secondaryStroke px-6 py-16 text-center" aria-live="polite">
          <p className="text-textSecondary">nobody is live. you could be.</p>
          <Link to="/live" className={buttonClassName('primary', 'mt-5')}>
            go live
          </Link>
        </div>
      )}
      <div id="list" className={cn(GRID, !list?.length && 'hidden')}>
        {list?.map((stream) => (
          <Card key={stream.name} stream={stream} now={now} bucket={bucket} />
        ))}
      </div>
    </PageFrame>
  );
}
