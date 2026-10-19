import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, messageOf } from '@/infra/api';
import { isDummyName } from '@/infra/names';
import { buttonClassName } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { TestBadge } from '@/shared-components/TestBadge';
import { cn } from '@/utils/cn';
import { since } from '@/utils/since';

const POLL_MS = 3000;
/** Thumbnails change every 5s on the publisher side; re-fetch on that rhythm. */
const THUMB_BUCKET_MS = 5000;

/**
 * The latest picture of a stream, or a quiet black box until there is one. A 404 (the first
 * picture takes ~6s, home lists the stream within 3s) only hides the img: the next bucket is a
 * new src on the same element, which loads again and shows it. Unmounting it would end that.
 */
function Thumb({ name, bucket }: { name: string; bucket: number }) {
  const [missing, setMissing] = useState(false);
  return (
    <span className="block h-[90px] w-[160px] overflow-hidden rounded-lg bg-black sm:h-[108px] sm:w-[192px]">
      <img
        src={api.thumbUrl(name, bucket)}
        alt=""
        data-thumb={name}
        className={cn('h-full w-full object-cover', missing && 'opacity-0')}
        onError={() => setMissing(true)}
        onLoad={() => setMissing(false)}
      />
    </span>
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
      title="live now"
      aside={
        <Link to="/live" className={buttonClassName('primary')}>
          go live
        </Link>
      }
    >
      {streams.error && (
        <p className="text-textSecondary" aria-live="polite">
          api is down: {messageOf(streams.error)}
        </p>
      )}
      {!streams.error && !streams.data && (
        <p id="loading" className="text-textSecondary">
          loading
        </p>
      )}
      {list?.length === 0 && (
        <p id="empty" className="text-textSecondary" aria-live="polite">
          nobody is live. you could be.
        </p>
      )}
      <div id="list">
        {list?.map((stream) => (
          <article key={stream.name} className="my-3 flex gap-4 rounded-xl border border-primaryStroke bg-backgroundSecondary p-3">
            <Link to={`/watch/${encodeURIComponent(stream.name)}`} aria-label={`watch ${stream.name}`} className="block shrink-0">
              <Thumb name={stream.name} bucket={bucket} />
            </Link>
            <div className="min-w-0 py-1">
              <Link to={`/watch/${encodeURIComponent(stream.name)}`} className="min-w-0 text-2xl font-semibold no-underline [overflow-wrap:anywhere]">
                <span aria-hidden className="mr-2 inline-block h-3 w-3 rounded-full bg-increase align-middle" />
                {stream.name}
              </Link>
              {stream.verified && (
                <span className="ml-1 text-increase" title="has an account: this really is them">
                  ✓
                </span>
              )}
              {isDummyName(stream.name) && <TestBadge />}
              <span className="ml-3 text-textSecondary">{since(stream.since, now)}</span>
              {stream.bio && <p className="mt-1 whitespace-pre-wrap text-textSecondary [overflow-wrap:anywhere]">{stream.bio}</p>}
            </div>
          </article>
        ))}
      </div>
    </PageFrame>
  );
}
