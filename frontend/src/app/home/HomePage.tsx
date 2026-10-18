import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, messageOf } from '@/infra/api';
import { isDummyName } from '@/infra/names';
import { buttonClassName } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { TestBadge } from '@/shared-components/TestBadge';
import { since } from '@/utils/since';

const POLL_MS = 3000;
/** Thumbnails change every 5s on the publisher side; re-fetch on that rhythm. */
const THUMB_BUCKET_MS = 5000;

/** The latest picture of a stream, or a quiet box until there is one. */
function Thumb({ name, bucket }: { name: string; bucket: number }) {
  const [missing, setMissing] = useState(false);
  const src = api.thumbUrl(name, bucket);
  return (
    <span className="block h-[90px] w-[160px] overflow-hidden rounded-lg bg-black sm:h-[108px] sm:w-[192px]">
      {!missing && <img src={src} alt="" data-thumb={name} className="h-full w-full object-cover" onError={() => setMissing(true)} onLoad={() => setMissing(false)} />}
    </span>
  );
}

export function HomePage() {
  const streams = useQuery({ queryKey: ['streams'], queryFn: api.streams, refetchInterval: POLL_MS });
  const bucket = Math.floor((streams.dataUpdatedAt || Date.now()) / THUMB_BUCKET_MS);

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
      {streams.data?.length === 0 && (
        <p id="empty" className="text-textSecondary" aria-live="polite">
          nobody is live. you could be.
        </p>
      )}
      <div id="list">
        {streams.data?.map((stream) => (
          <article key={stream.name} className="my-3 flex gap-4 rounded-xl border border-primaryStroke bg-backgroundSecondary p-3">
            <Link to={`/watch/${encodeURIComponent(stream.name)}`} className="block shrink-0">
              <Thumb name={stream.name} bucket={bucket} />
            </Link>
            <div className="min-w-0 py-1">
              <Link to={`/watch/${encodeURIComponent(stream.name)}`} className="min-w-0 text-2xl font-semibold no-underline [overflow-wrap:anywhere]">
                <span aria-hidden className="mr-2 inline-block h-3 w-3 rounded-full bg-increase align-middle" />
                {stream.name}
              </Link>
              {isDummyName(stream.name) && <TestBadge />}
              <span className="ml-3 text-textSecondary">{since(stream.since)}</span>
              {stream.bio && <p className="mt-1 whitespace-pre-wrap text-textSecondary [overflow-wrap:anywhere]">{stream.bio}</p>}
            </div>
          </article>
        ))}
      </div>
    </PageFrame>
  );
}
