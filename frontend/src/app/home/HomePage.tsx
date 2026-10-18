import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api, messageOf } from '@/infra/api';
import { isDummyName } from '@/infra/names';
import { buttonClassName } from '@/shared-components/Button';
import { PageFrame } from '@/shared-components/PageFrame';
import { TestBadge } from '@/shared-components/TestBadge';
import { since } from '@/utils/since';

const POLL_MS = 3000;

export function HomePage() {
  const streams = useQuery({ queryKey: ['streams'], queryFn: api.streams, refetchInterval: POLL_MS });

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
          <article key={stream.name} className="my-3 rounded-xl border border-primaryStroke bg-backgroundSecondary px-5 py-4">
            <Link to={`/watch/${encodeURIComponent(stream.name)}`} className="min-w-0 text-2xl font-semibold no-underline [overflow-wrap:anywhere]">
              <span aria-hidden className="mr-2 inline-block h-3 w-3 rounded-full bg-increase align-middle" />
              {stream.name}
            </Link>
            {isDummyName(stream.name) && <TestBadge />}
            <span className="ml-3 text-textSecondary">{since(stream.since)}</span>
            {stream.bio && <p className="mt-1 whitespace-pre-wrap text-textSecondary [overflow-wrap:anywhere]">{stream.bio}</p>}
          </article>
        ))}
      </div>
    </PageFrame>
  );
}
