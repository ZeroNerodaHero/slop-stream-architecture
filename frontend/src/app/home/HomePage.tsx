import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, messageOf, type LiveStream } from '@/infra/api';
import { isDummyName } from '@/infra/names';
import { Avatar } from '@/shared-components/Avatar';
import { buttonClassName } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { panelClassName } from '@/shared-components/Panel';
import { TestBadge } from '@/shared-components/TestBadge';
import { cn } from '@/utils/cn';
import { since } from '@/utils/since';

const POLL_MS = 3000;
/** Thumbnails change every 5s on the publisher side; re-fetch on that rhythm. */
const THUMB_BUCKET_MS = 5000;

/** One card per column, as many columns as fit: 1 on a phone, 2 on a tablet, 4 at full width. The gap leaves room for the shadows. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6';

/**
 * The latest picture of a stream, filling the box it is in, or a quiet black box until there
 * is one. A 404 (the first picture takes ~6s, home lists the stream within 3s) only hides the
 * img: the next bucket is a new src on the same element, which loads again and shows it.
 * Unmounting it would end that.
 */
function Thumb({ name, bucket }: { name: string; bucket: number }) {
  const [missing, setMissing] = useState(false);
  return (
    <img
      src={api.thumbUrl(name, bucket)}
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
    <article className={panelClassName('group', true)}>
      <Link to={`/watch/${encodeURIComponent(stream.name)}`} aria-label={`watch ${stream.name}`} className="block outline-none">
        {/* one chip, top right: "live for 52 hr". the fake streams draw their name top-left and a clock bottom-left */}
        <div className="relative aspect-video overflow-hidden border-b border-primaryStroke bg-black">
          <Thumb name={stream.name} bucket={bucket} />
          <span className="absolute right-3 top-3 flex items-center gap-1.5 border border-white/10 bg-black/70 px-2 py-0.5 text-sm font-semibold uppercase tracking-wide backdrop-blur-sm">
            <span aria-hidden className="h-2 w-2 animate-pulse bg-increase" />
            {age || 'live'}
          </span>
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
        <div key={i} className={panelClassName('animate-pulse')}>
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

  return (
    <PageFrame
      title={
        <>
          live now
          {list && list.length > 0 && <span className="ml-3 font-normal text-textTertiary">{list.length}</span>}
        </>
      }
      aside={
        <Link to="/live" className={buttonClassName('primary')}>
          go live
        </Link>
      }
      wide
    >
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
